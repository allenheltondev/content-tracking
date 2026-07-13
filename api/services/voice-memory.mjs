import { embedText } from "./embeddings.mjs";
import { putVoiceSample, deleteVoiceSample } from "./voice-vectors.mjs";
import { reflectVoiceProfile } from "./bedrock.mjs";
import { logger } from "./logger.mjs";
import { NotFoundError } from "./errors.mjs";
import { selectRecencyWeighted, voiceHalfLifeDays } from "./voice-recency.mjs";
import {
  countSampleOnce,
  createReflection,
  createVoiceSample,
  deleteVoiceSampleRow,
  getVoiceProfile,
  listRecentSamples,
  putVoiceProfile,
} from "../domain/voice.mjs";

// The shared "voice memory" core: turning a saved sample into episodic +
// semantic memory. Imported by BOTH the stream consumer (functions/voice-memory)
// and the API's manual-reflect route, so auto and manual reflection run the
// exact same path. Lives in api/services so the dependency direction stays
// functions → api (never the reverse).

// How many new samples trigger an automatic reflection. WINDOW (how many
// samples feed the diff) is at least the threshold plus some history so a
// reflection always sees the new batch in context. The window is selected by
// publish-date recency from a larger candidate pool (CANDIDATE_POOL), so the
// profile is always derived from the newest published voice — not merely the
// most recently captured rows.
const REFLECTION_THRESHOLD = Number(process.env.REFLECTION_THRESHOLD ?? 5);
const WINDOW = Math.max(REFLECTION_THRESHOLD, 10);
const CANDIDATE_POOL = Math.max(WINDOW * 3, 30);

// A blog "voice sample" should be representative prose, not the whole (up to
// 300KB) body — title + description + a leading excerpt captures the voice
// without bloating the vector/metadata.
const CONTENT_SAMPLE_MAX_CHARS = 4000;

// Processes one new (or re-written) VoiceSample: embed → upsert vector → count
// it once → reflect when the counter crosses the threshold.
//
// Ordering for exactly-once under at-least-once stream delivery:
//  1. The vector Put is idempotent (deterministic key), and runs first so a
//     counted sample always has a vector.
//  2. countSampleOnce marks the sample and increments the counter ATOMICALLY,
//     so a redelivery can neither double-count nor leave the sample counted
//     without its mark (or vice versa) — it simply skips.
//  3. Reflection is a best-effort follow-up. If it fails, the counter is not
//     reset, so it stays >= threshold and the next sample re-triggers it (and
//     the manual /reflect route is always available) — no work is lost.
export async function recordVoiceSample(sample) {
  const { tenantId, platform, sampleId, format, text, publishedAt } = sample;
  if (!tenantId || !platform || !sampleId || !text) {
    logger.warn("Skipping voice sample: missing fields", { tenantId, platform, sampleId });
    return { skipped: true, reason: "missing-fields" };
  }

  const embedding = await embedText(text);
  await putVoiceSample({ tenantId, platform, format, sampleId, text, embedding, publishedAt });

  const { counted, count } = await countSampleOnce(tenantId, platform, sampleId);
  if (!counted) {
    logger.info("Voice sample already counted; skipping", { platform, sampleId });
    return { skipped: true, reason: "already-counted" };
  }
  logger.info("Recorded voice sample", { platform, sampleId, count });

  if (count >= REFLECTION_THRESHOLD) {
    await runReflection(tenantId, platform);
  }
  return { count };
}

// (Re)derives the platform's style profile from its recent samples. Called
// automatically when the counter crosses the threshold, and on demand by
// POST /voice/profiles/{platform}/reflect. Returns the updated profile row (or
// null when there's nothing to learn from yet).
//
// Recency weighting: candidates are pulled from storage (capture order), then
// re-selected by publish date with exponential decay weights (see
// voice-recency.mjs) so the newest published voice dominates the window. Each
// sample's normalized weight share is handed to the model, which is prompted
// to let higher-weighted samples win stylistic conflicts — this is what makes
// the profile EVOLVE toward the current voice instead of averaging all time.
export async function runReflection(tenantId, platform) {
  const candidates = await listRecentSamples(tenantId, platform, CANDIDATE_POOL);
  if (candidates.length === 0) {
    logger.warn("Reflection skipped: no samples", { platform });
    return null;
  }
  const samples = selectRecencyWeighted(candidates, { limit: WINDOW });

  const current = await getVoiceProfile(tenantId, platform);
  const { profile, change_summary } = await reflectVoiceProfile({
    platform,
    currentProfile: current?.profile ?? null,
    samples,
  });

  const version = (current?.version ?? 0) + 1;
  const updated = await putVoiceProfile(tenantId, platform, {
    profile,
    version,
    createdAt: current?.createdAt,
  });
  await createReflection(tenantId, platform, {
    changeSummary: change_summary,
    sampleWindow: samples.length,
    model: process.env.BEDROCK_MODEL_ID ?? null,
    halfLifeDays: voiceHalfLifeDays(),
  });

  logger.info("Reflected voice profile", { platform, version, sampleWindow: samples.length });
  return updated;
}

// ---------------------------------------------------------------------------
// Auto-capture: published blog Content feeds the blog voice, per tenant.
// Called by the stream consumer on Content INSERT/MODIFY so every post added
// to the catalog becomes voice signal without any manual step.
// ---------------------------------------------------------------------------

// Deterministic sample id per content piece: re-capture (an edit) overwrites
// the same sample instead of duplicating, and delete needs no lookup.
export function contentVoiceSampleId(contentId) {
  return `CONTENT-${contentId}`;
}

export function buildContentSampleText(content, maxChars = CONTENT_SAMPLE_MAX_CHARS) {
  const parts = [content.title, content.description, (content.contentMarkdown ?? "").slice(0, maxChars)]
    .filter((s) => typeof s === "string" && s.trim().length > 0);
  return parts.join("\n\n").trim();
}

// Only the published blog catalog feeds the voice — drafts and scheduled
// pieces aren't the shipped voice yet, and non-blog types (video, social) are
// captured through their own channels.
export function isVoiceEligibleContent(content) {
  return content?.type === "blog"
    && content?.status === "published"
    && buildContentSampleText(content).length > 0;
}

// Turns a published blog Content row into (or refreshes) its VoiceSample. The
// sample's publishedAt anchors it on the recency-decay curve: the content's
// publishDate when set, else its creation time. Writing the sample row is what
// triggers the embed/count/reflect pipeline (via the VoiceSample stream
// filter) — this function itself does no Bedrock work.
export async function captureContentVoiceSample(content) {
  const { tenantId, contentId } = content ?? {};
  if (!tenantId || !contentId) {
    logger.warn("Skipping content voice capture: missing fields", { tenantId, contentId });
    return { skipped: true, reason: "missing-fields" };
  }
  if (!isVoiceEligibleContent(content)) {
    return { skipped: true, reason: "not-eligible" };
  }

  const sampleId = contentVoiceSampleId(contentId);
  await createVoiceSample(tenantId, {
    text: buildContentSampleText(content),
    platform: "blog",
    format: "blog",
    source: "content-auto",
    sampleId,
    publishedAt: content.publishDate ?? content.createdAt,
  });
  logger.info("Captured content voice sample", { contentId, sampleId });
  return { sampleId };
}

// Removes the voice sample derived from a content piece — used when the piece
// is deleted or stops being eligible (unpublished, re-typed). The vector goes
// first because DeleteVectors is idempotent; the row delete tolerates absence
// so redeliveries and never-captured pieces are clean no-ops.
export async function removeContentVoiceSample(content) {
  const { tenantId, contentId } = content ?? {};
  if (!tenantId || !contentId) {
    return { skipped: true, reason: "missing-fields" };
  }
  const sampleId = contentVoiceSampleId(contentId);
  await deleteVoiceSample({ tenantId, platform: "blog", sampleId });
  try {
    await deleteVoiceSampleRow(tenantId, "blog", sampleId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { skipped: true, reason: "no-sample" };
    }
    throw err;
  }
  logger.info("Removed content voice sample", { contentId, sampleId });
  return { sampleId };
}
