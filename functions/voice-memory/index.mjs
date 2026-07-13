import { unmarshall } from "@aws-sdk/util-dynamodb";
import { logger } from "../../api/services/logger.mjs";
import { recordVoiceSample } from "../../api/services/voice-memory.mjs";

// DynamoDB-stream-driven voice memory. A second event-source mapping on the
// shared table stream (the first feeds VectorizeContentFunction), filtered in
// template.yaml to INSERT records whose entity is "VoiceSample" — so this only
// sees new samples, never the VoiceProfile / VoiceReflection rows it writes
// (which would otherwise loop).
//
// Samples are immutable, so there is no MODIFY/REMOVE path here; the DELETE
// route removes a sample's vector explicitly.
//
// Records are processed independently; a record that throws bubbles up so the
// stream retries the batch, and exhausted retries land in the configured DLQ.
// The per-sample idempotency sentinel (recordVoiceSample) keeps a retry from
// double-counting toward the reflection threshold.
export const handler = async (event) => {
  const records = event?.Records ?? [];
  for (const record of records) {
    if (record.eventName !== "INSERT") continue;
    const image = record.dynamodb?.NewImage;
    if (!image) continue;

    const sample = unmarshall(image);
    if (sample.entity !== "VoiceSample") {
      logger.warn("Ignoring non-VoiceSample stream record", { entity: sample.entity, sk: sample.sk });
      continue;
    }

    await recordVoiceSample(sample);
  }
};
