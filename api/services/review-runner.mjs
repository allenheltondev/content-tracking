import { logger } from "./logger.mjs";
import { getContent } from "../domain/content.mjs";
import {
  claimReview,
  completeReview,
  getReview,
  listSuggestions,
  recordSuggestions,
  supersedePriorSuggestions,
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
  runVoiceGuard,
} from "./review-lenses.mjs";
import { analyzeVoiceSignature } from "./voice-signature.mjs";

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
//   { type: 'guard', dropped, kept }             the voice guard's arbitration
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

// Retrieves the on-voice grounding for a platform: the learned profile, the
// draft's nearest recency-ranked samples, and the measured signature derived
// from those samples. Returns { platform, profile, samples, signature } when
// there's anything to ground on, or null when the tenant has no voice for this
// platform yet.
//
// The return value now feeds every style lens, not just the brand one, so null
// is a much bigger deal than it used to be: it means the whole review runs with
// no idea how the author writes. The caller records that fact on the review
// (`lenses.voiceGrounded`) so a voice-blind run is visible downstream instead of
// looking exactly like a normal one.
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
    // Measured from the retrieved samples, so the habits describe the same
    // corpus the brand lens is reading. Null when the corpus is too small to
    // claim a habit from; the lenses handle that by falling back to the
    // profile's prose description alone.
    const signature = analyzeVoiceSignature(samples);
    return { platform, profile: profileRow?.profile ?? null, samples, signature };
  } catch (err) {
    logger.warn("Could not load Voice grounding; the review will run voice-blind", { error: err?.message });
    return null;
  }
}

// Suggestion types the voice guard arbitrates. Factual corrections are exempt:
// a wrong statistic is wrong no matter how it sounds, and the fact lens isn't
// the one flattening anyone. The brand lens is exempt too, since asking the
// voice grounding to veto its own output is incoherent.
const GUARDED_TYPES = new Set(["grammar", "llm"]);

// Runs the arbitration pass over what the voice-blind lenses proposed and
// returns the surviving set. No-ops (keeping everything) when there's no voice
// to judge against or nothing in scope to judge. Non-fatal by design: a guard
// that throws must not sink a review that has already done its work, so a
// failure degrades to the old behavior of publishing every suggestion.
async function guardVoice({ body, tenantId, voice, proposed, send }) {
  if (!voice) return { kept: proposed, dropped: 0 };

  const candidates = proposed.filter((s) => GUARDED_TYPES.has(s.type));
  if (candidates.length === 0) return { kept: proposed, dropped: 0 };

  try {
    await send({ type: "status", lens: "voice-guard", state: "running" });
    const dropIndexes = await runVoiceGuard({ body, tenantId, candidates, ...voice });
    // Identity-based: the guard returns positions in `candidates`, whose entries
    // are the same object references that sit in `proposed`. The Set collapses a
    // repeated index, and the filter discards an out-of-range one, so a
    // miscounting model can only ever veto fewer suggestions than it named.
    const drop = new Set(dropIndexes.map((i) => candidates[i]).filter(Boolean));
    const kept = proposed.filter((s) => !drop.has(s));
    await send({ type: "guard", dropped: drop.size, kept: kept.length });
    logger.info("Voice guard arbitrated the review", { proposed: proposed.length, dropped: drop.size });
    return { kept, dropped: drop.size };
  } catch (err) {
    logger.warn("Voice guard failed (non-fatal); keeping every suggestion", { error: err?.message });
    return { kept: proposed, dropped: 0 };
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
      { name: "readability", run: () => runReadabilityLens({ body, tenantId, voice }) },
      { name: "llm", run: () => runLlmLens({ body, tenantId, voice }) },
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

    const proposed = lensResults.flatMap((r) => r.suggestions);
    const { kept: suggestions, dropped } = await guardVoice({ body, tenantId, voice, proposed, send });
    const recorded = await recordSuggestions(tenantId, contentId, { reviewId, contentVersion, body, suggestions });

    // This run's findings replace the last run's: retire whatever an earlier
    // review left pending so a re-review (the CI loop: edit, PATCH, review
    // again) doesn't stack two sets of near-identical advice. Skipped when
    // every lens failed — that run has nothing to say and shouldn't clear what
    // the previous one found. Non-fatal: the new suggestions are already
    // recorded, and the leftovers age out on their own TTL.
    if (lensResults.some((r) => r.ok)) {
      await supersedePriorSuggestions(tenantId, contentId, { reviewId })
        .catch((err) => logger.warn("Could not supersede prior suggestions", { error: err?.message }));
    }

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
      // `counts` is what each lens PROPOSED. The voice guard runs after the
      // fan-out, so `vetoed` (and `recorded`) are what actually survived to the
      // author.
      counts: Object.fromEntries(lensResults.map((r) => [r.name, r.suggestions.length])),
      failed: lensResults.filter((r) => !r.ok).map((r) => r.name),
      voiceGrounded: Boolean(voice),
      vetoed: dropped,
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
