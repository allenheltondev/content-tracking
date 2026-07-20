import { logger } from "./logger.mjs";
import { getContent } from "../domain/content.mjs";
import {
  claimReview,
  completeReview,
  getReview,
  listSuggestions,
  recordSuggestions,
} from "../domain/content-review.mjs";
import { formatReview, formatSuggestion } from "../validation/content-review.mjs";
import { getVoiceProfile } from "../domain/voice.mjs";
import { embedText } from "./embeddings.mjs";
import { queryVoiceSamples } from "./voice-vectors.mjs";
import { COMPOSE_CANDIDATE_POOL, COMPOSE_EXAMPLE_COUNT, rankVoiceSamples } from "./voice-recency.mjs";
import {
  runBrandLens,
  runFactLens,
  runLensSafely,
  runLlmLens,
  runReadabilityLens,
  runSummaryLens,
} from "./review-lenses.mjs";

// The content review engine, shared by both entry points: the async
// EventBridge orchestrator (fire-and-forget) and the streaming Function URL
// (live). It fans out the lenses over the draft on the rsc-core
// @readysetcloud/agent runtime, records the anchored suggestions, and closes the
// review with a summary. Callers pass an optional `emit` to receive progress —
// the orchestrator ignores it; the stream endpoint forwards it to the client.
//
// The event contract (NDJSON on the stream):
//   { type: 'status', lens, state: 'running' }   a lens started
//   { type: 'lens', name, count, ok }            a lens finished
//   { type: 'suggestions', suggestions: [...] }  the recorded, anchored set
//   { type: 'summary', summary, verdict }        the editorial summary
//   { type: 'done', status }                     terminal success
//   { type: 'error', message }                   terminal failure

// Reads the fact lens's search-provider config from the environment. Returns
// null (fact lens skipped) unless a search URL is configured, so the lens is
// opt-in per deployment and no bespoke secret is required to run a review.
export function getFactSearchConfig() {
  const url = process.env.FACT_SEARCH_URL;
  if (!url) return null;
  const key = process.env.FACT_SEARCH_API_KEY;
  const headerName = process.env.FACT_SEARCH_AUTH_HEADER || "Authorization";
  return {
    url,
    ...(key ? { authHeader: { name: headerName, value: `Bearer ${key}` } } : {}),
  };
}

// Retrieves the on-voice grounding for a platform: the learned profile plus the
// draft's nearest, recency-ranked samples. Returns { platform, profile, samples }
// when there's anything to ground on, or null when the tenant has no voice for
// this platform yet (so the caller skips the brand lens rather than running it
// blind).
async function loadVoiceGrounding(tenantId, body, platformArg) {
  const platform = platformArg || "blog";
  try {
    const queryEmbedding = await embedText(body.slice(0, 8000));
    const [candidates, profileRow] = await Promise.all([
      queryVoiceSamples({ tenantId, queryEmbedding, platform, topK: COMPOSE_CANDIDATE_POOL }),
      getVoiceProfile(tenantId, platform),
    ]);
    const samples = rankVoiceSamples(candidates, { topK: COMPOSE_EXAMPLE_COUNT });
    if (!profileRow?.profile && samples.length === 0) return null;
    return { platform, profile: profileRow?.profile ?? null, samples };
  } catch (err) {
    logger.warn("Could not load Voice grounding; skipping brand lens", { error: err?.message });
    return null;
  }
}

// Runs (or resumes) a review. Claims it first for idempotency: the kickoff is
// at-least-once, and the async + streaming entry points can both fire for one
// review, so exactly one runs the lenses. A caller that loses the claim streams
// whatever the winner already produced.
export async function runReview({ tenantId, contentId, reviewId, contentVersion, platform, emit }) {
  const send = emit ?? (() => {});

  const claimed = await claimReview(tenantId, contentId, reviewId);
  if (!claimed) {
    // Someone else is running (or ran) this review — surface the current state.
    const [suggestions, review] = await Promise.all([
      listSuggestions(tenantId, contentId, { status: "pending" }),
      getReview(tenantId, contentId, reviewId).catch(() => null),
    ]);
    await send({ type: "suggestions", suggestions: suggestions.map(formatSuggestion) });
    if (review?.summary) await send({ type: "summary", summary: review.summary, verdict: review.lenses?.verdict ?? null });
    await send({ type: "done", status: review?.status ?? "running", review: formatReview(review) });
    return;
  }

  try {
    const content = await getContent(tenantId, contentId);
    const body = content.contentMarkdown ?? "";

    const voice = await loadVoiceGrounding(tenantId, body, platform);
    const search = getFactSearchConfig();

    const lensDefs = [
      { name: "readability", run: () => runReadabilityLens({ body, tenantId }) },
      { name: "llm", run: () => runLlmLens({ body, tenantId }) },
      ...(voice ? [{ name: "brand", run: () => runBrandLens({ body, tenantId, ...voice }) }] : []),
      ...(search ? [{ name: "fact", run: () => runFactLens({ body, tenantId, search }) }] : []),
    ];

    const lensResults = await Promise.all(
      lensDefs.map(async (d) => {
        await send({ type: "status", lens: d.name, state: "running" });
        const r = await runLensSafely(d.name, d.run);
        await send({ type: "lens", name: d.name, count: r.suggestions.length, ok: r.ok });
        return r;
      }),
    );

    const suggestions = lensResults.flatMap((r) => r.suggestions);
    const recorded = await recordSuggestions(tenantId, contentId, { reviewId, contentVersion, body, suggestions });
    await send({ type: "suggestions", suggestions: recorded.map(formatSuggestion) });

    let summary = null;
    let verdict = null;
    try {
      const s = await runSummaryLens({ body, findings: recorded, tenantId });
      summary = s.summary;
      verdict = s.verdict;
    } catch (err) {
      logger.warn("Summary lens failed (non-fatal)", { error: err?.message });
    }

    const lenses = {
      verdict,
      counts: Object.fromEntries(lensResults.map((r) => [r.name, r.suggestions.length])),
      failed: lensResults.filter((r) => !r.ok).map((r) => r.name),
      recorded: recorded.length,
    };

    await completeReview(tenantId, contentId, reviewId, { status: "succeeded", summary, lenses });
    await send({ type: "summary", summary, verdict });
    await send({ type: "done", status: "succeeded" });
    logger.info("Review completed", { recorded: recorded.length, verdict });
  } catch (err) {
    logger.error("Review failed", { error: err?.message, stack: err?.stack });
    await completeReview(tenantId, contentId, reviewId, {
      status: "failed",
      summary: "The review could not be completed.",
    }).catch((e) => logger.warn("Could not mark review failed", { error: e?.message }));
    await send({ type: "error", message: "The review could not be completed." });
    throw err;
  }
}
