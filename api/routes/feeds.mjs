import { requireTenantId } from "../services/identity.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError } from "../services/errors.mjs";
import { aggregateFeeds } from "../services/rss.mjs";
import { suggestContentAngles } from "../services/bedrock.mjs";
import { logger } from "../services/logger.mjs";
import {
  createFeedSource,
  deleteFeedSource,
  listFeedSources,
  recordFeedFetch,
  updateFeedSource,
} from "../domain/feed.mjs";
import { listProfiles } from "../domain/voice.mjs";
import { listContentByTenant } from "../domain/content.mjs";
import {
  IDEAS_ITEM_DEFAULT,
  formatContentIdeas,
  formatFeedItem,
  formatFeedResult,
  formatFeedSource,
  validateFeedCreate,
  validateFeedUpdate,
  validateIdeasRequest,
} from "../validation/feed.mjs";

// Content Radar: a customizable RSS feed a creator curates, plus an AI agent
// that reads what those feeds are publishing and proposes content angles in
// the creator's own voice. Feed sources are managed as tenant-scoped CRUD; the
// aggregate feed and the idea generation both fetch the sources live (never
// stored) so the radar can't go stale. Every route resolves the tenant from
// the authorizer sub (requireTenantId) so reads/writes stay inside the
// caller's TENANT#{sub} partition.

// Upper bound on aggregated items returned by the feed endpoint. A creator
// follows a handful of feeds, so this comfortably covers a live view.
const FEED_ITEM_CAP = 60;

// How many of the creator's own recent titles we pass the ideas agent as the
// "topics you build on" signal. Enough to convey their lane without bloating
// the prompt.
const RECENT_TOPIC_COUNT = 30;

export function registerFeedRoutes(app) {
  // POST /content-radar/feeds — add a feed source to the radar.
  app.post("/content-radar/feeds", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const fields = validateFeedCreate(parseBody(event));
    const item = await createFeedSource(tenantId, fields);
    return jsonResponse(201, formatFeedSource(item));
  });

  // GET /content-radar/feeds — the creator's feed sources (with health).
  app.get("/content-radar/feeds", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const items = await listFeedSources(tenantId);
    return jsonResponse(200, { feeds: items.map(formatFeedSource) });
  });

  // PATCH /content-radar/feeds/{feedId} — rename or mute a source.
  app.patch("/content-radar/feeds/:feedId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const fields = validateFeedUpdate(parseBody(event));
    const updated = await updateFeedSource(tenantId, params.feedId, fields);
    return jsonResponse(200, formatFeedSource(updated));
  });

  // DELETE /content-radar/feeds/{feedId} — remove a source.
  app.delete("/content-radar/feeds/:feedId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    await deleteFeedSource(tenantId, params.feedId);
    return emptyResponse(204);
  });

  // GET /content-radar/feed — the live aggregated feed across all active
  // (non-muted) sources, newest first. This is the "customizable RSS feed":
  // one merged, de-duplicated stream the creator curates by managing sources.
  app.get("/content-radar/feed", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const limit = parseLimit(event.queryStringParameters?.limit, FEED_ITEM_CAP);

    const active = (await listFeedSources(tenantId)).filter((s) => s.muted !== true);
    if (active.length === 0) {
      return jsonResponse(200, { items: [], sources: [] });
    }

    const { items, results } = await aggregateFeeds(active, { limit });
    await stampFeedHealth(tenantId, results);

    return jsonResponse(200, {
      items: items.map(formatFeedItem),
      sources: results.map(formatFeedResult),
    });
  });

  // POST /content-radar/ideas — read the live feed and propose content angles
  // in the creator's voice. Grounds the agent in what's being published now
  // (the feed items), how the creator writes (their learned voice portraits),
  // and what they already build on (their recent content titles). Nothing is
  // persisted — regenerating is a fresh read, like POST /voice/compose.
  app.post("/content-radar/ideas", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const { platform, guidance, feedIds, limit } = validateIdeasRequest(parseBody(event, { optional: true }));

    const sources = await listFeedSources(tenantId);
    const active = selectActiveSources(sources, feedIds);
    if (active.length === 0) {
      throw new BadRequestError(
        "No feed sources to read from. Add feeds to your radar (POST /content-radar/feeds) first.",
      );
    }

    // Pull the feed snapshot alongside the creator's voice + topics so the
    // agent has all three grounding signals. The voice/topics reads are
    // best-effort context — a cold-start creator with neither still gets
    // general angles from the feeds.
    const [{ items, results }, profiles, recentTopics] = await Promise.all([
      aggregateFeeds(active, { limit: limit ?? IDEAS_ITEM_DEFAULT }),
      listProfiles(tenantId).catch((err) => {
        logger.warn("Voice profiles unavailable for ideas (non-fatal)", { error: err?.message });
        return [];
      }),
      recentTopicTitles(tenantId),
    ]);
    await stampFeedHealth(tenantId, results);

    const voicePortraits = profiles
      .map((p) => ({ platform: p.platform, portrait: p.profile?.portrait }))
      .filter((p) => typeof p.portrait === "string" && p.portrait.length > 0);

    // Bedrock errors propagate as UpstreamError → 502; nothing is persisted.
    const ideas = await suggestContentAngles({
      items,
      voicePortraits,
      recentTopics,
      platform,
      guidance,
    });

    return jsonResponse(200, {
      ...formatContentIdeas(ideas),
      sources: results.map(formatFeedResult),
    });
  });
}

// Restricts the source list to the active (non-muted) sources, and — when the
// caller passed feed_ids — to that subset. A muted source stays excluded even
// if named, since muting is the creator's "don't read this" signal.
function selectActiveSources(sources, feedIds) {
  const active = sources.filter((s) => s.muted !== true);
  if (!Array.isArray(feedIds) || feedIds.length === 0) return active;
  const wanted = new Set(feedIds);
  return active.filter((s) => wanted.has(s.feedId));
}

// The creator's recent content titles — the "topics you build on" signal for
// the ideas agent. Best-effort: a read failure just means the agent works from
// voice + feeds. Titles only; nothing else is needed.
async function recentTopicTitles(tenantId) {
  try {
    const { items } = await listContentByTenant(tenantId, { limit: RECENT_TOPIC_COUNT });
    return (items ?? [])
      .map((c) => (typeof c.title === "string" ? c.title.trim() : ""))
      .filter((t) => t.length > 0);
  } catch (err) {
    logger.warn("Recent topics unavailable for ideas (non-fatal)", { error: err?.message });
    return [];
  }
}

// Best-effort per-source health stamp after an aggregation. Runs the writes
// concurrently and swallows failures (a source deleted mid-fetch, a throttle)
// so health tracking never fails the read it rides along with.
async function stampFeedHealth(tenantId, results) {
  await Promise.allSettled(
    (results ?? []).map((r) =>
      recordFeedFetch(tenantId, r.feedId, { ok: r.ok, itemCount: r.itemCount, error: r.error }),
    ),
  );
}

// Parses a positive-integer `limit` query param, clamped to [1, cap]. Falls
// back to the cap when absent or invalid rather than erroring — a feed read
// should be forgiving.
function parseLimit(raw, cap) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return cap;
  return Math.min(n, cap);
}

function parseBody(event, { optional = false } = {}) {
  if (!event.body) {
    if (optional) return {};
    throw new BadRequestError("Missing request body");
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}
