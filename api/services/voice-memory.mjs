import { embedText } from "./embeddings.mjs";
import { putVoiceSample, deleteVoiceSample } from "./voice-vectors.mjs";
import { reflectVoiceProfile } from "./bedrock.mjs";
import { logger } from "./logger.mjs";
import { NotFoundError } from "./errors.mjs";
import { isEligibleSample, selectRecencyWeighted, voiceHalfLifeDays } from "./voice-recency.mjs";
import { enqueueReflectionCatchup } from "./reflection-queue.mjs";
import {
  claimReflectionSlot,
  countSampleOnce,
  createReflection,
  createVoiceSample,
  deleteVoiceSampleRow,
  getVoiceProfile,
  getVoiceSample,
  listRecentSamples,
  putVoiceProfile,
  setVoiceSampleMuted,
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

// Automatic-reflection debounce. Under a burst (e.g. a 230-post backfill) a
// naive "reflect every N samples" would fire dozens of Bedrock reflections in
// minutes — a stampede that throttles and churns the profile. Instead the
// stream path COALESCES: it reflects at most once per cooldown window (an
// atomic claim picks a single winner), and each reflection enqueues a delayed
// catch-up so the burst's tail still converges once ingress goes quiet. The
// cooldown is the only knob; it does not need touching for bulk loads.
const REFLECTION_COOLDOWN_SECONDS = Number(process.env.VOICE_REFLECTION_COOLDOWN_SECONDS ?? 60);
const REFLECTION_COOLDOWN_MS = REFLECTION_COOLDOWN_SECONDS * 1000;
// A claim older than the lease is treated as abandoned (a crashed reflection),
// so a stuck claim can't block reflection forever.
const REFLECTION_LEASE_MS = Number(process.env.VOICE_REFLECTION_LEASE_SECONDS ?? 300) * 1000;
// Fire the catch-up just after the cooldown expires (SQS delay caps at 900s).
const REFLECTION_CATCHUP_DELAY_SECONDS = Math.min(900, REFLECTION_COOLDOWN_SECONDS + 15);

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
  const { tenantId, platform, sampleId, format, text, publishedAt, createdAt, source } = sample;
  if (!tenantId || !platform || !sampleId || !text) {
    logger.warn("Skipping voice sample: missing fields", { tenantId, platform, sampleId });
    return { skipped: true, reason: "missing-fields" };
  }

  // Generated drafts (saved from Compose) are kept as rows for reference but
  // never enter the vector index or the reflection cadence — otherwise the
  // model's own output could be retrieved as a few-shot example and teach the
  // voice about itself. A draft the creator wants to count as their voice
  // should be saved as `manual` (endorsing it), not `generated`.
  if (source === "generated") {
    logger.info("Skipping generated voice sample (excluded from the voice)", { platform, sampleId });
    return { skipped: true, reason: "generated" };
  }

  const embedding = await embedText(text);
  // The vector's recency anchor mirrors effectiveSampleDate: publish date when
  // known, capture time otherwise — so undated manual samples still rank by
  // their real freshness at compose time instead of the neutral fallback.
  await putVoiceSample({
    tenantId, platform, format, sampleId, text, embedding,
    publishedAt: publishedAt ?? createdAt,
  });

  const { counted, count } = await countSampleOnce(tenantId, platform, sampleId);
  if (!counted) {
    logger.info("Voice sample already counted; skipping", { platform, sampleId });
    return { skipped: true, reason: "already-counted" };
  }
  logger.info("Recorded voice sample", { platform, sampleId, count });

  if (count >= REFLECTION_THRESHOLD) {
    await maybeReflect(tenantId, platform);
  }
  return { count };
}

// The COALESCED reflection entry point for the automatic (stream) path — both
// the per-sample trigger and the SQS catch-up call this. It claims the single
// reflection slot for the cooldown window; if it loses the claim (another
// reflection ran recently, or is in flight, or the profile isn't dirty) it
// simply skips — the pending catch-up or the next sample will cover it. On a
// win it enqueues the next catch-up FIRST (so the tail still converges even if
// the reflection then throttles) and runs the reflection best-effort. Never
// throws, so a reflection hiccup never fails the caller's stream record.
export async function maybeReflect(tenantId, platform) {
  const claimed = await claimReflectionSlot(tenantId, platform, {
    now: Date.now(),
    cooldownMs: REFLECTION_COOLDOWN_MS,
    leaseMs: REFLECTION_LEASE_MS,
    threshold: REFLECTION_THRESHOLD,
  });
  if (!claimed) {
    logger.info("Reflection coalesced — cooldown/claim not available", { platform });
    return { reflected: false, reason: "coalesced" };
  }

  // Guarantee the trailing edge: even if ingress goes silent right after this,
  // a catch-up will re-attempt a reflection once the cooldown expires.
  await enqueueReflectionCatchup({ tenantId, platform, delaySeconds: REFLECTION_CATCHUP_DELAY_SECONDS })
    .catch((err) => logger.warn("Failed to enqueue reflection catch-up (non-fatal)", { platform, error: err?.message }));

  try {
    const profile = await runReflection(tenantId, platform);
    return { reflected: true, profile };
  } catch (err) {
    logger.warn("Reflection failed (will retry via catch-up)", { platform, error: err?.message });
    return { reflected: false, reason: "error" };
  }
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
//
// Two kinds of sample never feed the learned voice:
//   - muted samples, which the creator has deliberately excluded, and
//   - generated samples, so the model's own drafts can't teach the voice about
//     itself (a feedback loop that would erode authenticity over time).
// Only authored/published work defines the profile.
export async function runReflection(tenantId, platform) {
  const candidates = await listRecentSamples(tenantId, platform, CANDIDATE_POOL);
  const eligible = candidates.filter(isEligibleSample);
  const current = await getVoiceProfile(tenantId, platform);

  if (eligible.length === 0) {
    // Nothing left to learn from. If a learned profile exists (e.g. the last
    // authored sample was just muted/deleted), CLEAR it so its stale traits
    // stop driving compose — leaving it in place would let a voice with 0
    // eligible samples keep generating. When there's no profile yet, it's a
    // plain no-op. Idempotent: a null profile isn't re-cleared.
    if (!current || current.profile == null) {
      logger.warn("Reflection skipped: no eligible samples", { platform, candidates: candidates.length });
      return current ?? null;
    }
    const clearedVersion = (current.version ?? 0) + 1;
    const cleared = await putVoiceProfile(tenantId, platform, {
      profile: null,
      version: clearedVersion,
      createdAt: current.createdAt,
      steering: current.steering ?? null,
    });
    await createReflection(tenantId, platform, {
      changeSummary: "Voice cleared — no eligible samples remain to learn from.",
      sampleWindow: 0,
      model: process.env.BEDROCK_MODEL_ID ?? null,
      halfLifeDays: voiceHalfLifeDays(),
      version: clearedVersion,
      portrait: null,
    });
    logger.info("Cleared voice profile (no eligible samples)", { platform, version: clearedVersion });
    return cleared;
  }

  const samples = selectRecencyWeighted(eligible, { limit: WINDOW });

  const { profile, change_summary } = await reflectVoiceProfile({
    platform,
    currentProfile: current?.profile ?? null,
    samples,
    // The creator's stated intent for where the voice should head.
    steering: current?.steering ?? null,
  });

  const version = (current?.version ?? 0) + 1;
  const updated = await putVoiceProfile(tenantId, platform, {
    profile,
    version,
    createdAt: current?.createdAt,
    steering: current?.steering ?? null,
  });
  await createReflection(tenantId, platform, {
    changeSummary: change_summary,
    sampleWindow: samples.length,
    model: process.env.BEDROCK_MODEL_ID ?? null,
    halfLifeDays: voiceHalfLifeDays(),
    version,
    portrait: typeof profile?.portrait === "string" ? profile.portrait : null,
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
//
// If the creator has muted this sample, re-capture is skipped entirely: the
// muted row is left as-is, so muting a published post is a DURABLE exclusion
// that survives later edits to the post rather than silently coming back.
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
  const existing = await getVoiceSample(tenantId, "blog", sampleId);
  if (existing?.muted) {
    logger.info("Skipping content voice capture: sample muted", { contentId, sampleId });
    return { skipped: true, reason: "muted" };
  }

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

// --- curation (mute / unmute / delete from the dashboard) -------------------
// Moved out of routes/voice.mjs: each action keeps the row store, the vector
// store, and the learned profile in sync, so the route stays HTTP glue.

// After a curation action (mute, unmute, delete, steer) re-derives the profile
// so the change is reflected in the learned voice right away. Best-effort: a
// reflection failure must not fail the user's action — the manual "Refresh now"
// path and the next automatic reflection both recover. Returns the updated
// profile row, or null when nothing could be reflected.
export async function reflectAfterCuration(tenantId, platform) {
  try {
    return await runReflection(tenantId, platform);
  } catch (err) {
    logger.warn("Post-curation reflection failed (non-fatal)", { platform, error: err?.message });
    return null;
  }
}

// Mutes or unmutes a sample and syncs the vector store: muting drops the
// vector (the row stays, visible and reversible); unmuting re-embeds from the
// stored text so the sample rejoins compose retrieval. Re-derives the profile
// either way. Returns the updated sample row.
export async function setSampleMutedAndSync(tenantId, platform, sampleId, muted) {
  const updated = await setVoiceSampleMuted(tenantId, platform, sampleId, muted);
  if (muted) {
    await deleteVoiceSample({ tenantId, platform, sampleId });
  } else {
    const embedding = await embedText(updated.text);
    await putVoiceSample({
      tenantId, platform, format: updated.format, sampleId,
      text: updated.text, embedding, publishedAt: updated.publishedAt ?? updated.createdAt,
    });
  }
  await reflectAfterCuration(tenantId, platform);
  return updated;
}

// Removes a sample row and its vector, then re-derives the profile so the
// removal takes effect immediately.
export async function removeSampleAndSync(tenantId, platform, sampleId) {
  await deleteVoiceSampleRow(tenantId, platform, sampleId);
  await deleteVoiceSample({ tenantId, platform, sampleId });
  await reflectAfterCuration(tenantId, platform);
}
