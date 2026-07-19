import { logger } from "../../api/services/logger.mjs";
import { getContent } from "../../api/domain/content.mjs";
import { recordSuggestions, completeReview } from "../../api/domain/content-review.mjs";
import { getVoiceProfile } from "../../api/domain/voice.mjs";
import { embedText } from "../../api/services/embeddings.mjs";
import { queryVoiceSamples } from "../../api/services/voice-vectors.mjs";
import { COMPOSE_CANDIDATE_POOL, COMPOSE_EXAMPLE_COUNT, rankVoiceSamples } from "../../api/services/voice-recency.mjs";
import {
  runBrandLens,
  runLensSafely,
  runLlmLens,
  runReadabilityLens,
  runSummaryLens,
} from "../../api/services/review-lenses.mjs";

// The content review engine. Triggered by the "Start Content Review" event that
// POST /content/{id}/reviews emits, it fans out the review lenses over the
// draft on the rsc-core @readysetcloud/agent runtime, records the anchored
// suggestions, and closes the review with an editorial summary.
//
// Lenses run in parallel and are individually error-isolated (runLensSafely):
// one lens failing degrades the review rather than sinking it. A fatal error
// (can't load the content, can't record) marks the review `failed` and rethrows
// so the async invocation lands in the DLQ. Retries are disabled on the
// function (EventInvokeConfig MaximumRetryAttempts: 0) so a failed run can't
// double-write suggestions — the user re-triggers instead.
export const handler = async (event) => {
  const detail = event?.detail ?? {};
  const { tenantId, contentId, reviewId, contentVersion, platform } = detail;
  if (!tenantId || !contentId || !reviewId) {
    logger.error("Start Content Review event missing identifiers", { detail });
    return;
  }

  logger.appendKeys({ tenantId, contentId, reviewId });

  try {
    const content = await getContent(tenantId, contentId);
    const body = content.contentMarkdown ?? "";

    // Gather the Voice grounding for the on-voice (brand) lens: the learned
    // profile plus the draft's nearest, most-recent real posts. Reuses Booked's
    // Voice feature as the single source of truth for "sounds like you".
    const voice = await loadVoiceGrounding(tenantId, body, platform);

    const lensResults = await Promise.all([
      runLensSafely("readability", () => runReadabilityLens({ body, tenantId })),
      runLensSafely("llm", () => runLlmLens({ body, tenantId })),
      ...(voice
        ? [runLensSafely("brand", () => runBrandLens({ body, tenantId, ...voice }))]
        : []),
    ]);

    const suggestions = lensResults.flatMap((r) => r.suggestions);
    const recorded = await recordSuggestions(tenantId, contentId, {
      reviewId,
      contentVersion,
      body,
      suggestions,
    });

    // Summarize over what was actually recorded (post-anchoring/dedup), so the
    // editorial summary matches the suggestions the author will see. Best-effort:
    // a summary failure still closes the review as succeeded.
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
    logger.info("Review completed", { recorded: recorded.length, verdict });
  } catch (err) {
    logger.error("Review failed", { error: err?.message, stack: err?.stack });
    // Best-effort: record the failure so the client stops polling a pending run.
    await completeReview(tenantId, contentId, reviewId, {
      status: "failed",
      summary: "The review could not be completed.",
    }).catch((e) => logger.warn("Could not mark review failed", { error: e?.message }));
    throw err; // → DLQ (no retry)
  }
};

// Retrieves the on-voice grounding for a platform: the learned profile plus the
// draft's nearest, recency-ranked samples. Returns { platform, profile, samples }
// when there's anything to ground on, or null when the tenant has no voice for
// this platform yet (so the orchestrator skips the brand lens rather than
// running it blind).
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
