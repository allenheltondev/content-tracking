import { embedText } from "./embeddings.mjs";
import { putVoiceSample } from "./voice-vectors.mjs";
import { reflectVoiceProfile } from "./bedrock.mjs";
import { logger } from "./logger.mjs";
import {
  bumpSampleCounter,
  createReflection,
  getVoiceProfile,
  listRecentSamples,
  markSampleVectorized,
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

// Processes one new VoiceSample: embed → upsert vector → (idempotently) bump the
// platform counter → reflect when the counter crosses the threshold.
//
// Ordering matters for exactly-once: the vector Put is idempotent (deterministic
// key), then a conditional sentinel gates the non-idempotent counter bump, so a
// redelivered stream record re-puts the (identical) vector and then no-ops.
export async function recordVoiceSample(sample) {
  const { tenantId, platform, sampleId, format, text } = sample;
  if (!tenantId || !platform || !sampleId || !text) {
    logger.warn("Skipping voice sample: missing fields", { tenantId, platform, sampleId });
    return { skipped: true, reason: "missing-fields" };
  }

  const embedding = await embedText(text);
  await putVoiceSample({ tenantId, platform, format, sampleId, text, embedding });

  const firstTime = await markSampleVectorized(tenantId, platform, sampleId);
  if (!firstTime) {
    logger.info("Voice sample already counted; skipping bump", { platform, sampleId });
    return { skipped: true, reason: "already-counted" };
  }

  const count = await bumpSampleCounter(tenantId, platform);
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
