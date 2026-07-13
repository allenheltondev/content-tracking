import { unmarshall } from "@aws-sdk/util-dynamodb";
import { logger } from "../../api/services/logger.mjs";
import {
  captureContentVoiceSample,
  isVoiceEligibleContent,
  recordVoiceSample,
  removeContentVoiceSample,
} from "../../api/services/voice-memory.mjs";

// DynamoDB-stream-driven voice memory. A second event-source mapping on the
// shared table stream (the first feeds VectorizeContentFunction), filtered in
// template.yaml to two entity families:
//
//   VoiceSample (INSERT/MODIFY) — embed → count → maybe reflect. MODIFYs are
//     processed only when the text changed: countSampleOnce's own vectorizedAt
//     stamp is a MODIFY too, and re-embedding it would loop cost for nothing.
//     A genuine text change (an edited post re-captured) re-embeds and counts
//     again — an edit is fresh voice signal.
//
//   Content, type=blog (INSERT/MODIFY/REMOVE) — auto-capture: every published
//     blog post becomes (or refreshes) a deterministic VoiceSample, which then
//     flows through the VoiceSample path above. The profile/reflection rows
//     this function writes carry other entity values and never re-trigger it.
//
// Records are processed independently; a record that throws bubbles up so the
// stream retries the batch, and exhausted retries land in the configured DLQ.
// The per-sample idempotency sentinel (recordVoiceSample) keeps a retry from
// double-counting toward the reflection threshold.
export const handler = async (event) => {
  const records = event?.Records ?? [];
  for (const record of records) {
    await handleRecord(record);
  }
};

async function handleRecord(record) {
  const eventName = record.eventName;
  const newImage = record.dynamodb?.NewImage ? unmarshall(record.dynamodb.NewImage) : null;
  const oldImage = record.dynamodb?.OldImage ? unmarshall(record.dynamodb.OldImage) : null;

  if (eventName === "REMOVE") {
    // Only blog Content REMOVEs pass the stream filter: a deleted post takes
    // its voice sample (row + vector) with it.
    if (oldImage?.entity === "Content" && oldImage.type === "blog") {
      await removeContentVoiceSample(oldImage);
    }
    return;
  }

  if (!newImage) return;

  if (newImage.entity === "VoiceSample") {
    // Re-process a MODIFY only when the text or recency anchor moved — the
    // vector (and its publishedAt metadata) must follow both, but
    // countSampleOnce's own vectorizedAt stamp changes neither.
    if (eventName === "MODIFY"
      && oldImage?.text === newImage.text
      && oldImage?.publishedAt === newImage.publishedAt) return;
    await recordVoiceSample(newImage);
    return;
  }

  if (newImage.entity === "Content") {
    // Skip MODIFYs that didn't touch the voice-relevant fields (the publish
    // flow mirrors links/ids onto the root constantly).
    if (eventName === "MODIFY" && !contentVoiceFieldsChanged(oldImage, newImage)) return;

    const result = await captureContentVoiceSample(newImage);
    // A piece that used to feed the voice but no longer qualifies
    // (unpublished, emptied, re-typed) takes its sample with it.
    if (result?.skipped && oldImage && isVoiceEligibleContent(oldImage)) {
      await removeContentVoiceSample(newImage);
    }
    return;
  }

  logger.warn("Ignoring unexpected stream record", { entity: newImage.entity, sk: newImage.sk });
}

// The Content root fields that shape its voice sample. Anything else changing
// (links, ids, tags, campaign linkage) is voice-irrelevant noise.
const CONTENT_VOICE_FIELDS = ["title", "description", "contentMarkdown", "publishDate", "status", "type"];

function contentVoiceFieldsChanged(oldImage, newImage) {
  if (!oldImage) return true;
  return CONTENT_VOICE_FIELDS.some((field) => oldImage[field] !== newImage[field]);
}
