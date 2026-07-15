import {
  attachCampaign,
  createContent,
  deleteContent,
  detachCampaign,
  getContent,
  listContentByTenant,
  listContentStats,
  listPublishVariants,
  putPublishVariant,
  putStatsSnapshot,
  updateContent,
} from "../domain/content.mjs";
import { createCampaign, findCampaign } from "../domain/campaign.mjs";
import { getTenant } from "../domain/tenant.mjs";
import { getBlogCredentials } from "../services/blog-credentials.mjs";
import { transformBlogForPlatform } from "../services/parse-blog.mjs";
import { getAdapter } from "../services/blog-platforms/index.mjs";
import { validateCrosspostRequest } from "../validation/blog.mjs";
import { requirePublisherTenantId, requireTenantId } from "../services/identity.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError, ConflictError, NotFoundError } from "../services/errors.mjs";
import { embedText } from "../services/embeddings.mjs";
import { queryContentChunks } from "../services/content-vectors.mjs";
import { answerContentQuestion } from "../services/bedrock.mjs";
import { formatCampaign, validateCampaignCreate } from "../validation/campaign.mjs";
import {
  formatPublishVariant,
  formatStatsSnapshot,
  validatePlatform,
  validatePublishVariant,
  validateStatsUpdate,
} from "../validation/content-analytics.mjs";
import {
  formatContent,
  formatContentAnswer,
  formatContentSummary,
  validateContentCreate,
  validateContentQuestion,
  validateContentUpdate,
} from "../validation/content.mjs";

const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function requireCampaignId(value) {
  if (typeof value !== "string" || !CAMPAIGN_ID_RE.test(value)) {
    throw new BadRequestError("campaign_id must be 1-64 characters of letters, digits, underscores, or hyphens");
  }
  return value;
}

// Content catalog CRUD. Every route resolves the tenant from the authorizer
// sub (requireTenantId) and passes it as the first argument to the domain,
// so reads/writes are confined to the caller's TENANT#{sub} partition.

export function registerContentRoutes(app) {
  app.post("/content", withIdempotency(async ({ event }) => {
    // Publish endpoint — dashboard or API key (see requirePublisherTenantId).
    const tenantId = requirePublisherTenantId(event);
    const fields = validateContentCreate(parseBody(event));
    const item = await createContent(tenantId, fields);
    return jsonResponse(201, formatContent(item));
  }));

  // POST /content/ask — RAG Q&A over the tenant's content catalog. Embeds the
  // question, retrieves the nearest chunks from the vector index (tenant-
  // scoped, optionally one piece or one type), and asks Bedrock to answer
  // grounded in them. Registered before /content/:contentId so the literal
  // path wins. Nothing is persisted; a retry just re-runs.
  app.post("/content/ask", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const { question, topK, contentId, type } = validateContentQuestion(parseBody(event));

    const queryEmbedding = await embedText(question);
    const chunks = await queryContentChunks({ tenantId, queryEmbedding, topK, contentId, type });

    // No vectors matched (empty catalog or nothing relevant): answer plainly
    // without spending a Bedrock call.
    if (chunks.length === 0) {
      return jsonResponse(200, formatContentAnswer({
        answer: "I couldn't find anything in your content catalog relevant to that question.",
        confidence: "low",
        citations: [],
      }));
    }

    const { answer, sources_used, confidence } = await answerContentQuestion({ question, chunks });
    return jsonResponse(200, formatContentAnswer({
      answer,
      confidence: confidence ?? "low",
      citations: resolveCitations(sources_used, chunks),
    }));
  });

  // GET /content — the single content catalog. Content is the sole entity now,
  // so this is a straight paginated Query on the tenant's content, newest-first,
  // with optional type/source/status filters.
  app.get("/content", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const qs = event.queryStringParameters ?? {};
    const limit = parseLimit(qs.limit);
    const exclusiveStartKey = decodeCursor(qs.startKey);
    const { items, lastEvaluatedKey } = await listContentByTenant(tenantId, {
      limit,
      exclusiveStartKey,
      type: qs.type,
      source: qs.source,
      status: qs.status,
    });
    return jsonResponse(200, {
      content: items.map(formatContentSummary),
      nextStartKey: encodeCursor(lastEvaluatedKey),
    });
  });

  app.get("/content/:contentId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const content = await getContent(tenantId, params.contentId);
    return jsonResponse(200, formatContent(content));
  });

  app.patch("/content/:contentId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const { contentId } = params;
    const fields = validateContentUpdate(parseBody(event));
    if (Object.keys(fields).length === 0) {
      throw new BadRequestError("request body must contain at least one updatable field");
    }

    // campaign_id owns a bidirectional 1:1 link (with a back-pointer on the
    // campaign row), so it flows through attach/detach rather than the generic
    // partial update. A null campaign_id clears the sponsorship.
    if (Object.prototype.hasOwnProperty.call(fields, "campaignId")) {
      const { campaignId, ...rest } = fields;
      let current = campaignId === null
        ? await detachCampaign(tenantId, contentId)
        : await attachCampaign(tenantId, contentId, campaignId);
      if (Object.keys(rest).length > 0) {
        current = await updateContent(tenantId, contentId, rest);
      }
      return jsonResponse(200, formatContent(current));
    }

    const updated = await updateContent(tenantId, contentId, fields);
    return jsonResponse(200, formatContent(updated));
  });

  app.delete("/content/:contentId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    await deleteContent(tenantId, params.contentId);
    return emptyResponse(204);
  });

  // --- Sponsorship: the campaign that hangs off a content piece (1:1) -------

  // The attached campaign, or 404 for an unsponsored piece.
  app.get("/content/:contentId/campaign", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const content = await getContent(tenantId, params.contentId);
    if (!content.campaignId) {
      throw new NotFoundError("Campaign", `attached to content ${params.contentId}`);
    }
    const campaign = await findCampaign(content.campaignId);
    if (!campaign) {
      throw new NotFoundError("Campaign", content.campaignId);
    }
    return jsonResponse(200, formatCampaign(campaign));
  });

  // Attach an existing campaign to this content piece.
  app.put("/content/:contentId/campaign", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const campaignId = requireCampaignId(parseBody(event).campaign_id);
    const content = await attachCampaign(tenantId, params.contentId, campaignId);
    return jsonResponse(200, formatContent(content));
  });

  // Create a campaign and attach it in one step (create content → sponsor it).
  app.post("/content/:contentId/campaign", withIdempotency(async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const { contentId } = params;

    // Pre-check the content is unsponsored so a create+attach conflict can't
    // leave an orphaned campaign behind.
    const content = await getContent(tenantId, contentId);
    if (content.campaignId) {
      throw new ConflictError(`Content ${contentId} already has a campaign attached`);
    }

    const fields = validateCampaignCreate(parseBody(event));
    // Stamp the owner so the campaign is tenant-scoped from creation; the
    // content↔campaign guard enforces ownership on subsequent attaches.
    const campaign = await createCampaign({ ...fields, tenantId });
    await attachCampaign(tenantId, contentId, campaign.campaignId);
    return jsonResponse(201, formatCampaign({ ...campaign, contentId }));
  }));

  // Detach the sponsorship, leaving an unsponsored piece. The campaign itself
  // survives — it just loses its content back-pointer.
  app.delete("/content/:contentId/campaign", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    await detachCampaign(tenantId, params.contentId);
    return emptyResponse(204);
  });

  // --- Publishing + analytics (works for any piece, sponsored or not) -------

  // Record where a piece was published (one row per platform; re-posting the
  // same platform updates it). Independent of the campaign machinery, so an
  // unsponsored piece can track its own distribution.
  app.post("/content/:contentId/publish", withIdempotency(async ({ event, params }) => {
    const tenantId = requirePublisherTenantId(event);
    await getContent(tenantId, params.contentId); // 404 if the piece is gone
    const { platform, ...fields } = validatePublishVariant(parseBody(event));
    const item = await putPublishVariant(tenantId, params.contentId, platform, fields);
    return jsonResponse(201, formatPublishVariant(item));
  }));

  app.get("/content/:contentId/publish", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const variants = await listPublishVariants(tenantId, params.contentId);
    return jsonResponse(200, {
      content_id: params.contentId,
      publish_variants: variants
        .map(formatPublishVariant)
        .sort((a, b) => a.platform.localeCompare(b.platform)),
    });
  });

  // Record a metric snapshot for one platform on the current UTC day (same-day
  // writes overwrite). The analogue of the campaign social-post analytics PUT,
  // but for a piece of content's own performance.
  app.put("/content/:contentId/stats/:platform", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    await getContent(tenantId, params.contentId); // 404 so stats can't orphan
    const platform = validatePlatform(params.platform);
    const { metrics, capturedAt } = validateStatsUpdate(parseBody(event));
    const date = (capturedAt ? new Date(capturedAt) : new Date()).toISOString().slice(0, 10);
    const item = await putStatsSnapshot(tenantId, params.contentId, platform, date, {
      metrics,
      ...(capturedAt ? { capturedAt } : {}),
    });
    return jsonResponse(200, formatStatsSnapshot(item));
  });

  // Cross-post a piece of content to dev.to / Medium / Hashnode. Unlike the
  // legacy /blogs crosspost (a durable, staggerable function that reads the Blog
  // entity), this publishes synchronously off the Content row so content-native
  // pieces — which have no Blog row — can cross-post too. Each successful
  // publish is recorded as a publish variant, so it flows into content
  // analytics. Platforms already published (a variant with a url exists) are
  // skipped so a re-invoke can't create duplicate posts.
  app.post("/content/:contentId/crosspost", withIdempotency(async ({ event, params }) => {
    const tenantId = requirePublisherTenantId(event);
    const { contentId } = params;
    const content = await getContent(tenantId, contentId);
    const { platforms } = validateCrosspostRequest(parseBody(event));

    const [tenant, credentials, catalogPage, existingVariants] = await Promise.all([
      getTenant(tenantId),
      getBlogCredentials(tenantId),
      listContentByTenant(tenantId, { limit: 1000 }),
      listPublishVariants(tenantId, contentId),
    ]);
    const baseUrl = tenant?.canonicalBaseUrl;
    const catalog = catalogPage.items ?? [];
    const alreadyPublished = new Map(
      existingVariants.filter((v) => v.url).map((v) => [v.platform, v.url]),
    );

    const results = [];
    for (const platform of platforms) {
      if (alreadyPublished.has(platform)) {
        results.push({ platform, status: "skipped", url: alreadyPublished.get(platform) });
        continue;
      }
      try {
        const transformed = transformBlogForPlatform({ blog: content, catalog, platform, baseUrl });
        const config = tenant?.platforms?.[platform] ?? {};
        const published = await getAdapter(platform).publish({
          blog: content,
          content: transformed.body,
          tags: transformed.tags,
          config,
          credential: credentials?.[platform],
        });
        await putPublishVariant(tenantId, contentId, platform, {
          url: published.url,
          publishedAt: new Date().toISOString(),
        });
        results.push({ platform, status: "succeeded", url: published.url });
      } catch (err) {
        results.push({ platform, status: "failed", error: String(err?.message ?? err) });
      }
    }

    return jsonResponse(200, { content_id: contentId, results });
  }));

  // Combined analytics read: where the piece is published plus its per-platform
  // daily metric series, so the content detail page can chart performance.
  app.get("/content/:contentId/analytics", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const [variants, stats] = await Promise.all([
      listPublishVariants(tenantId, params.contentId),
      listContentStats(tenantId, params.contentId),
    ]);

    const byPlatform = new Map();
    for (const s of stats) {
      if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, []);
      byPlatform.get(s.platform).push(formatStatsSnapshot(s));
    }

    return jsonResponse(200, {
      content_id: params.contentId,
      publish_variants: variants
        .map(formatPublishVariant)
        .sort((a, b) => a.platform.localeCompare(b.platform)),
      stats: [...byPlatform.entries()]
        .map(([platform, snapshots]) => ({
          platform,
          snapshots: snapshots.sort((a, b) => a.date.localeCompare(b.date)),
        }))
        .sort((a, b) => a.platform.localeCompare(b.platform)),
    });
  });
}

// Maps the model's 1-based source_used numbers back to the pieces they point
// at, deduped to one citation per piece of content (the same piece can
// contribute several chunks). Out-of-range numbers are ignored so a stray
// index can't crash the response.
function resolveCitations(sourcesUsed, chunks) {
  const seen = new Set();
  const citations = [];
  for (const n of sourcesUsed ?? []) {
    const chunk = chunks[n - 1];
    if (!chunk || !chunk.contentId || seen.has(chunk.contentId)) continue;
    seen.add(chunk.contentId);
    citations.push({ contentId: chunk.contentId, title: chunk.title, slug: chunk.slug, type: chunk.type });
  }
  return citations;
}

function parseBody(event) {
  if (!event.body) {
    throw new BadRequestError("Missing request body");
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}
