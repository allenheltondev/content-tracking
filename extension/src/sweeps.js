// Sweep tracking for the background worker. A "sweep" is a batch of posts for
// one campaign that the worker scrapes through the shared tab-group queue, and
// that must end with a single sweep-complete call. This module holds the pure
// logic (post selection, due checks, completion bookkeeping) with no chrome
// dependency so it unit-tests directly. background.js owns the I/O.

const HOUR_MS = 60 * 60 * 1000;

// Choices for the scheduled auto sweep, in hours. 0 turns it off.
export const SWEEP_INTERVAL_CHOICES = [0, 6, 12, 24];
export const DEFAULT_SWEEP_INTERVAL_HOURS = 24;

// Resolve the configured interval. `dailySweepEnabled: false` is the older
// on/off flag and still turns the sweep off when no interval was chosen.
export function sweepIntervalHours(cfg = {}) {
  const hours = Number(cfg.sweepIntervalHours);
  if (SWEEP_INTERVAL_CHOICES.includes(hours)) return hours;
  return cfg.dailySweepEnabled === false ? 0 : DEFAULT_SWEEP_INTERVAL_HOURS;
}

// Minimum gap between scheduled sweeps. The once-a-day choice waits 20 hours,
// not 24, so a late 15-minute alarm tick never pushes a run to the next day.
export function sweepIntervalMs(hours) {
  return hours >= 24 ? 20 * HOUR_MS : hours * HOUR_MS;
}

// Per-tab lifetime cap used to size a sweep's deadline. Mirrors
// AUTO_SCRAPE_MAX_LIFETIME_MS in background.js.
const SLOT_MS = 90_000;

function toMs(value) {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Tolerates a missing or malformed `refresh_requests` (an old API omits it).
// Keeps one entry per campaign, the latest requested_at winning.
export function normalizeRefreshRequests(raw) {
  if (!Array.isArray(raw)) return [];
  const byCampaign = new Map();
  for (const r of raw) {
    if (!r || typeof r.campaign_id !== "string" || !r.campaign_id) continue;
    const prev = byCampaign.get(r.campaign_id);
    if (!prev || (toMs(r.requested_at) ?? 0) > (toMs(prev.requested_at) ?? 0)) {
      byCampaign.set(r.campaign_id, { campaign_id: r.campaign_id, requested_at: r.requested_at });
    }
  }
  return [...byCampaign.values()];
}

// A requested sweep that keeps failing reports in as complete after this many
// attempts, so one unscrapable post cannot hold a request open forever.
export const MAX_REQUESTED_SWEEP_ATTEMPTS = 3;

// Decide what a finished sweep tells the server. A sweep with failed posts is
// partial: the server keeps the pending request and the next tick retries.
// `attempts` counts earlier partial results for the same requested sweep.
export function sweepCompletion({ source, failedCount, attempts = 0 }) {
  if (!failedCount) return { partial: false, attempts: 0 };
  if (source !== "requested") return { partial: true, attempts: 0 };
  const next = attempts + 1;
  if (next >= MAX_REQUESTED_SWEEP_ATTEMPTS) return { partial: false, attempts: 0 };
  return { partial: true, attempts: next };
}

// Posts of the requested campaign that still need a scrape: not already synced
// after the request was made. Posts that are already being scraped are kept,
// so the sweep waits for them instead of finishing ahead of their stats.
export function selectRequestedPosts(feed, request) {
  const requestedMs = toMs(request?.requested_at);
  const seen = new Set();
  const out = [];
  for (const p of feed || []) {
    if (p.campaign_id !== request?.campaign_id) continue;
    if (seen.has(p.post_id)) continue;
    seen.add(p.post_id);
    const fetchedMs = toMs(p.last_fetched);
    if (fetchedMs !== null && requestedMs !== null && fetchedMs > requestedMs) continue;
    out.push(p);
  }
  return out;
}

// A post synced within the last half interval is fresh enough to skip, so a
// manual sync shortly before a scheduled sweep is not repeated.
export function isFreshForSweep(post, intervalHours, now = Date.now()) {
  const fetchedMs = toMs(post.last_fetched);
  if (fetchedMs === null) return false;
  return now - fetchedMs < (intervalHours * HOUR_MS) / 2;
}

// Scheduled sweep selection across all campaigns. Returns Map(campaignId -> posts).
export function selectScheduledPosts(
  feed,
  now = Date.now(),
  { intervalHours = DEFAULT_SWEEP_INTERVAL_HOURS, skipCampaignIds = new Set() } = {},
) {
  const byCampaign = new Map();
  const seen = new Set();
  for (const p of feed || []) {
    if (!p.campaign_id || seen.has(p.post_id)) continue;
    seen.add(p.post_id);
    if (skipCampaignIds.has(p.campaign_id)) continue;
    if (isFreshForSweep(p, intervalHours, now)) continue;
    if (!byCampaign.has(p.campaign_id)) byCampaign.set(p.campaign_id, []);
    byCampaign.get(p.campaign_id).push(p);
  }
  return byCampaign;
}

export function isScheduledSweepDue({
  intervalHours = DEFAULT_SWEEP_INTERVAL_HOURS,
  lastRunAt,
  now = Date.now(),
} = {}) {
  if (!intervalHours) return false;
  const last = toMs(lastRunAt);
  if (last === null) return true;
  return now - last >= sweepIntervalMs(intervalHours);
}

// Open a scrape tab and register it for completion tracking before anything
// else is awaited. Grouping the tab is slow enough that a fast page can report
// its stats first; an unregistered tab would miss that capture, sit until its
// timeout, and be recorded as a failure. A grouping error is not fatal.
export async function openTrackedTab({ create, register, group }) {
  const tab = await create();
  register(tab);
  if (group) {
    try {
      await group(tab);
    } catch (err) {
      console.warn("[booked] grouping scrape tab failed:", err);
    }
  }
  return tab;
}

// Upper bound on how long a sweep of `count` posts can legitimately take: each
// wave of `maxConcurrent` tabs lives at most one tab lifetime, plus a spare wave.
export function sweepDeadline(startedAt, count, maxConcurrent = 5) {
  return startedAt + (Math.ceil(count / Math.max(1, maxConcurrent)) + 1) * SLOT_MS;
}

// In-memory sweep bookkeeping with a JSON snapshot so the worker can persist it.
// A campaign has at most one sweep. `begin` reserves the campaign synchronously
// (so two concurrent ticks cannot both start one); `seal` fixes the pending set.
// Only sealed sweeps can drain, and `finish` removes a sweep so the caller
// reports completion exactly once. Each post leaves with an outcome; posts
// whose stats did not reach the API are kept as `failed`.
export function createSweepTracker({ maxConcurrent = 5 } = {}) {
  const sweeps = new Map(); // campaignId -> { source, startedAt, deadline, pending:Set, failed:Set, sealed }

  return {
    has: (campaignId) => sweeps.has(campaignId),
    campaignIds: () => [...sweeps.keys()],

    begin(campaignId, source, now = Date.now()) {
      if (sweeps.has(campaignId)) return false;
      sweeps.set(campaignId, {
        source,
        startedAt: now,
        deadline: now,
        pending: new Set(),
        failed: new Set(),
        sealed: false,
      });
      return true;
    },

    seal(campaignId, postIds, now = Date.now()) {
      const s = sweeps.get(campaignId);
      if (!s) return;
      s.pending = new Set(postIds);
      s.deadline = sweepDeadline(now, s.pending.size, maxConcurrent);
      s.sealed = true;
    },

    // A post left the scrape pipeline. `ok` is true only when its stats
    // reached the API; a timeout, a failed tab, or a failed write is false.
    // Returns the campaigns whose sweeps are now fully drained. They stay
    // tracked until `finish` so the caller can read their outcome first.
    markDone(postId, ok = true) {
      const drained = [];
      for (const [campaignId, s] of sweeps) {
        if (!s.sealed || !s.pending.delete(postId)) continue;
        if (!ok) s.failed.add(postId);
        if (s.pending.size === 0) drained.push(campaignId);
      }
      return drained;
    },

    // True while some sealed sweep is still waiting on this post.
    isPending(postId) {
      for (const s of sweeps.values()) if (s.sealed && s.pending.has(postId)) return true;
      return false;
    },

    // Posts that did not sync: recorded failures plus anything still pending
    // (an overdue sweep is finished with posts outstanding).
    failedPostIds(campaignId) {
      const s = sweeps.get(campaignId);
      return s ? [...new Set([...s.failed, ...s.pending])] : [];
    },

    // Remove the sweep. True only for the caller that actually removed it.
    finish: (campaignId) => sweeps.delete(campaignId),

    source: (campaignId) => sweeps.get(campaignId)?.source ?? null,
    pendingPostIds: (campaignId) => [...(sweeps.get(campaignId)?.pending ?? [])],

    // Sealed sweeps past their deadline: something got lost, complete them anyway.
    overdue: (now = Date.now()) =>
      [...sweeps].filter(([, s]) => s.sealed && now >= s.deadline).map(([id]) => id),

    snapshot() {
      const out = {};
      for (const [id, s] of sweeps) {
        if (!s.sealed) continue;
        out[id] = {
          source: s.source,
          startedAt: s.startedAt,
          pending: [...s.pending],
          failed: [...s.failed],
        };
      }
      return out;
    },

    // Load a persisted snapshot after a worker restart. Campaigns already
    // tracked in memory win. Deadlines are re-armed from `now` because the
    // caller is about to requeue the pending posts. Returns restored ids.
    restore(saved, now = Date.now()) {
      const restored = [];
      if (!saved || typeof saved !== "object") return restored;
      for (const [id, s] of Object.entries(saved)) {
        if (sweeps.has(id) || !s || !Array.isArray(s.pending)) continue;
        sweeps.set(id, {
          source: s.source || "restored",
          startedAt: toMs(s.startedAt) ?? now,
          deadline: sweepDeadline(now, s.pending.length, maxConcurrent),
          pending: new Set(s.pending),
          failed: new Set(Array.isArray(s.failed) ? s.failed : []),
          sealed: true,
        });
        restored.push(id);
      }
      return restored;
    },
  };
}
