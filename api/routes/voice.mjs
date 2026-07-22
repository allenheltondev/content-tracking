import { requireTenantId } from "../services/identity.mjs";
import { trackActivity } from "../services/activity.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { emptyResponse, jsonResponse, parseBody } from "../services/http-handler.mjs";
import { embedText } from "../services/embeddings.mjs";
import { queryVoiceSamples } from "../services/voice-vectors.mjs";
import { composeVoicePost, assessVoiceMatch } from "../services/bedrock.mjs";
import {
  reflectAfterCuration,
  removeSampleAndSync,
  runReflection,
  setSampleMutedAndSync,
} from "../services/voice-memory.mjs";
import {
  COMPOSE_CANDIDATE_POOL,
  COMPOSE_EXAMPLE_COUNT,
  isEligibleSample,
  rankVoiceSamples,
  selectRecencyWeighted,
  summarizeVoiceCorpus,
} from "../services/voice-recency.mjs";
import {
  createVoiceSample,
  getVoiceProfile,
  listProfiles,
  listReflections,
  listRecentSamples,
  setVoiceSteering,
} from "../domain/voice.mjs";
import {
  formatVoiceAssessment,
  formatVoiceDraft,
  formatVoiceOverviewEntry,
  formatVoiceProfile,
  formatVoiceReflection,
  formatVoiceSample,
  validateComposeRequest,
  validatePlatform,
  validateSampleCreate,
  validateSampleUpdate,
  validateSteeringRequest,
  validateVoiceCheckRequest,
} from "../validation/voice.mjs";

// The "voice" feature: learn the creator's per-platform writing style and draft
// in it. Every route resolves the tenant from the authorizer sub
// (requireTenantId) so reads/writes stay inside the caller's TENANT#{sub}
// partition. Style learning happens off the DynamoDB stream
// (VoiceMemoryFunction); these routes drive composing, capturing samples, and
// reading/triggering the learned profiles.

// Upper bound on samples pulled per platform for the overview's corpus stats.
// A creator's per-platform corpus is personal-scale, so this comfortably covers
// the whole history while capping a pathological tenant.
const OVERVIEW_SAMPLE_CAP = 500;

export function registerVoiceRoutes(app) {
  // POST /voice/compose — draft a post in the creator's voice. Embeds the topic,
  // retrieves a pool of nearby past samples for the platform (episodic memory),
  // re-ranks them by topical similarity blended with publish-date recency (so
  // the examples reflect the CURRENT voice — see voice-recency.mjs), pairs them
  // with the learned style profile (semantic memory), and asks Bedrock to
  // write. Nothing is persisted; "save" is a separate POST /voice/samples.
  app.post("/voice/compose", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const { topic, platform, format, guidance } = validateComposeRequest(parseBody(event));

    const queryEmbedding = await embedText(topic);
    const [candidates, profileRow] = await Promise.all([
      queryVoiceSamples({ tenantId, queryEmbedding, platform, topK: COMPOSE_CANDIDATE_POOL }),
      getVoiceProfile(tenantId, platform),
    ]);
    const samples = rankVoiceSamples(candidates, { topK: COMPOSE_EXAMPLE_COUNT });

    const draft = await composeVoicePost({
      topic,
      platform,
      format,
      profile: profileRow?.profile ?? null,
      samples,
      guidance,
    });
    // Gamification: each composed draft counts toward the "Ghostwriter" tier.
    // Nothing is persisted for a compose, so there's no natural idempotency id;
    // an occasional double-count on a client retry is harmless for a
    // count-up-to-N badge.
    await trackActivity(tenantId, "voice.composed");
    return jsonResponse(200, formatVoiceDraft(draft));
  });

  // POST /voice/check — grade an arbitrary draft against the learned voice
  // (paste-and-score). Same retrieval as compose — the draft's own text is the
  // query, so the closest, most-recent examples ground the assessment — but
  // instead of writing it asks Bedrock how on-voice the draft already is.
  // Nothing is persisted.
  app.post("/voice/check", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const { draft, platform } = validateVoiceCheckRequest(parseBody(event));

    const queryEmbedding = await embedText(draft);
    const [candidates, profileRow] = await Promise.all([
      queryVoiceSamples({ tenantId, queryEmbedding, platform, topK: COMPOSE_CANDIDATE_POOL }),
      getVoiceProfile(tenantId, platform),
    ]);
    const samples = rankVoiceSamples(candidates, { topK: COMPOSE_EXAMPLE_COUNT });

    const assessment = await assessVoiceMatch({
      platform,
      profile: profileRow?.profile ?? null,
      samples,
      draft,
    });
    return jsonResponse(200, formatVoiceAssessment(assessment));
  });

  // GET /voice/overview — the flagship read: for every platform the creator has
  // a profile on, the plain-English portrait plus corpus transparency (how many
  // samples, from where, over what date range, and how concentrated the current
  // voice is in recent posts). One call powers the whole voice dashboard.
  app.get("/voice/overview", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const profiles = await listProfiles(tenantId);

    const entries = await Promise.all(profiles.map(async (profileRow) => {
      const samples = await listRecentSamples(tenantId, profileRow.platform, OVERVIEW_SAMPLE_CAP);
      const summary = summarizeVoiceCorpus(samples);
      return formatVoiceOverviewEntry({ profileRow, summary });
    }));

    return jsonResponse(200, { platforms: entries });
  });

  // POST /voice/samples — capture a writing sample (manual paste, or "save" a
  // generated draft). The stream consumer embeds it, counts it toward the next
  // reflection, and reflects when the threshold is crossed.
  app.post("/voice/samples", withIdempotency(async ({ event }) => {
    const tenantId = requireTenantId(event);
    const fields = validateSampleCreate(parseBody(event));
    const item = await createVoiceSample(tenantId, fields);
    // Gamification: capturing a writing sample is the "Found Your Voice"
    // activity. Idempotent per sample so a retried Idempotency-Key won't
    // double-count.
    await trackActivity(tenantId, "voice.sample.captured", {
      id: `voice.sample.captured#${tenantId}#${item.sampleId}`,
    });
    return jsonResponse(201, formatVoiceSample(item));
  }));

  // GET /voice/samples?platform= — recent samples for a platform (newest
  // first), each annotated with its current influence share on the voice (the
  // recency weight it would carry in reflection, normalized over the eligible
  // corpus). Muted / generated samples report 0 — they don't drive the voice.
  app.get("/voice/samples", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const platform = validatePlatform(event.queryStringParameters?.platform);
    const items = await listRecentSamples(tenantId, platform);

    const eligible = items.filter(isEligibleSample);
    const shareById = new Map(
      selectRecencyWeighted(eligible).map((s) => [s.sampleId, s.weightShare]),
    );
    return jsonResponse(200, {
      samples: items.map((s) => formatVoiceSample(s, { influenceShare: shareById.get(s.sampleId) ?? 0 })),
    });
  });

  // PATCH /voice/samples/{id}?platform= — mute or unmute a sample. Muting keeps
  // the row (so it's visible and reversible) but drops its vector and excludes
  // it from reflection, so it no longer drives the voice; unmuting re-embeds it.
  // The profile is re-derived so the change takes effect immediately.
  app.patch("/voice/samples/:id", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const platform = validatePlatform(event.queryStringParameters?.platform);
    const { muted } = validateSampleUpdate(parseBody(event));

    const updated = await setSampleMutedAndSync(tenantId, platform, params.id, muted);
    return jsonResponse(200, formatVoiceSample(updated));
  });

  // DELETE /voice/samples/{id}?platform= — remove a sample row and its vector.
  // platform comes from the query because the ULID id alone doesn't locate the
  // platform-scoped key. For an auto-captured post, prefer PATCH muted:true —
  // delete is not durable (a later edit re-captures it), whereas muting sticks.
  // The profile is re-derived so the removal takes effect immediately.
  app.delete("/voice/samples/:id", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const platform = validatePlatform(event.queryStringParameters?.platform);
    await removeSampleAndSync(tenantId, platform, params.id);
    return emptyResponse(204);
  });

  // GET /voice/profiles — every per-platform profile for the tenant.
  app.get("/voice/profiles", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const items = await listProfiles(tenantId);
    return jsonResponse(200, { profiles: items.map(formatVoiceProfile) });
  });

  // GET /voice/profiles/{platform} — one profile plus its recent reflections.
  app.get("/voice/profiles/:platform", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const platform = validatePlatform(params.platform);
    const [profile, reflections] = await Promise.all([
      getVoiceProfile(tenantId, platform),
      listReflections(tenantId, platform),
    ]);
    return jsonResponse(200, {
      profile: formatVoiceProfile(profile),
      reflections: reflections.map(formatVoiceReflection),
    });
  });

  // PUT /voice/profiles/{platform}/steering — set (or clear with note:null) the
  // creator's intent note ("what I'm going for lately"). It biases the next
  // reflection, which we run now so the steer takes effect immediately.
  app.put("/voice/profiles/:platform/steering", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const platform = validatePlatform(params.platform);
    const { note } = validateSteeringRequest(parseBody(event));

    await setVoiceSteering(tenantId, platform, note);
    const reflected = await reflectAfterCuration(tenantId, platform);
    // Fall back to the freshly-steered row if there was nothing to reflect yet.
    const profile = reflected ?? await getVoiceProfile(tenantId, platform);
    return jsonResponse(200, { profile: formatVoiceProfile(profile) });
  });

  // POST /voice/profiles/{platform}/reflect — re-derive the profile now from
  // recent samples (the same path the stream runs automatically every N samples).
  app.post("/voice/profiles/:platform/reflect", withIdempotency(async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const platform = validatePlatform(params.platform);
    const updated = await runReflection(tenantId, platform);
    return jsonResponse(200, { profile: formatVoiceProfile(updated) });
  }));
}