import { embedText } from "./embeddings.mjs";
import { putVoiceSample } from "./voice-vectors.mjs";
import { reflectVoiceProfile } from "./bedrock.mjs";
import { logger } from "./logger.mjs";
import {
  countSampleOnce,
  createReflection,
  getVoiceProfile,
  listRecentSamples,
  putVoiceProfile,
} from "../domain/voice.mjs";

// The shared "voice memory" core: turning a saved sample into episodic +
// semantic memory. Imported by BOTH the stream consumer (functions/voice-memory)
// and the API's manual-reflect route, so auto and manual reflection run the
// exact same path. Lives in api/services so the dependency direction stays
// functions → api (never the reverse).

// How many new samples trigger an automatic reflection. WINDOW (how many recent
// samples feed the diff) is at least the threshold plus some history so a
// reflection always sees the new batch in context.
const REFLECTION_THRESHOLD = Number(process.env.REFLECTION_THRESHOLD ?? 5);
const WINDOW = Math.max(REFLECTION_THRESHOLD, 10);

// Processes one new VoiceSample: embed → upsert vector → count it once → reflect
// when the counter crosses the threshold.
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
  const { tenantId, platform, sampleId, format, text } = sample;
  if (!tenantId || !platform || !sampleId || !text) {
    logger.warn("Skipping voice sample: missing fields", { tenantId, platform, sampleId });
    return { skipped: true, reason: "missing-fields" };
  }

  const embedding = await embedText(text);
  await putVoiceSample({ tenantId, platform, format, sampleId, text, embedding });

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
export async function runReflection(tenantId, platform) {
  const samples = await listRecentSamples(tenantId, platform, WINDOW);
  if (samples.length === 0) {
    logger.warn("Reflection skipped: no samples", { platform });
    return null;
  }

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
  });

  logger.info("Reflected voice profile", { platform, version, sampleWindow: samples.length });
  return updated;
}
