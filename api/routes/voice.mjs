import { requireTenantId } from "../services/identity.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError } from "../services/errors.mjs";
import { embedText } from "../services/embeddings.mjs";
import { queryVoiceSamples, deleteVoiceSample } from "../services/voice-vectors.mjs";
import { composeVoicePost } from "../services/bedrock.mjs";
import { runReflection } from "../services/voice-memory.mjs";
import {
  createVoiceSample,
  deleteVoiceSampleRow,
  getVoiceProfile,
  listProfiles,
  listReflections,
  listRecentSamples,
} from "../domain/voice.mjs";
import {
  formatVoiceDraft,
  formatVoiceProfile,
  formatVoiceReflection,
  formatVoiceSample,
  validateComposeRequest,
  validatePlatform,
  validateSampleCreate,
} from "../validation/voice.mjs";

// The "voice" feature: learn the creator's per-platform writing style and draft
// in it. Every route resolves the tenant from the authorizer sub
// (requireTenantId) so reads/writes stay inside the caller's TENANT#{sub}
// partition. Style learning happens off the DynamoDB stream
// (VoiceMemoryFunction); these routes drive composing, capturing samples, and
// reading/triggering the learned profiles.

export function registerVoiceRoutes(app) {
  // POST /voice/compose — draft a post in the creator's voice. Embeds the topic,
  // retrieves the nearest past samples for the platform (episodic memory) and the
  // learned style profile (semantic memory), and asks Bedrock to write. Nothing
  // is persisted; "save" is a separate POST /voice/samples. Mirrors /blogs/ask.
  app.post("/voice/compose", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const { topic, platform, format, guidance } = validateComposeRequest(parseBody(event));

    const queryEmbedding = await embedText(topic);
    const [samples, profileRow] = await Promise.all([
      queryVoiceSamples({ tenantId, queryEmbedding, platform }),
      getVoiceProfile(tenantId, platform),
    ]);

    const draft = await composeVoicePost({
      topic,
      platform,
      format,
      profile: profileRow?.profile ?? null,
      samples,
      guidance,
    });
    return jsonResponse(200, formatVoiceDraft(draft));
  });

  // POST /voice/samples — capture a writing sample (manual paste, or "save" a
  // generated draft). The stream consumer embeds it, counts it toward the next
  // reflection, and reflects when the threshold is crossed.
  app.post("/voice/samples", withIdempotency(async ({ event }) => {
    const tenantId = requireTenantId(event);
    const fields = validateSampleCreate(parseBody(event));
    const item = await createVoiceSample(tenantId, fields);
    return jsonResponse(201, formatVoiceSample(item));
  }));

  // GET /voice/samples?platform= — recent samples for a platform (newest first).
  app.get("/voice/samples", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const platform = validatePlatform(event.queryStringParameters?.platform);
    const items = await listRecentSamples(tenantId, platform);
    return jsonResponse(200, { samples: items.map(formatVoiceSample) });
  });

  // DELETE /voice/samples/{id}?platform= — remove a sample row and its vector.
  // platform comes from the query because the ULID id alone doesn't locate the
  // platform-scoped key.
  app.delete("/voice/samples/:id", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const platform = validatePlatform(event.queryStringParameters?.platform);
    await deleteVoiceSampleRow(tenantId, platform, params.id);
    await deleteVoiceSample({ tenantId, platform, sampleId: params.id });
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

  // POST /voice/profiles/{platform}/reflect — re-derive the profile now from
  // recent samples (the same path the stream runs automatically every N samples).
  app.post("/voice/profiles/:platform/reflect", withIdempotency(async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const platform = validatePlatform(params.platform);
    const updated = await runReflection(tenantId, platform);
    return jsonResponse(200, { profile: formatVoiceProfile(updated) });
  }));
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
