import { unmarshall } from "@aws-sdk/util-dynamodb";
import { logger } from "../../api/services/logger.mjs";
import { vectorizeContent, removeContentVectors } from "./vectorize.mjs";

// DynamoDB-stream-driven content vectorizer. The event source mapping is
// filtered (in template.yaml) to records whose entity is "Content", so this
// only sees content ROOT inserts/modifies/deletes — never the per-platform
// publish rows, stats snapshots, or its own ContentVectorIndex state row
// (which would otherwise loop).
//
//   INSERT / MODIFY -> (re)embed the content and upsert its chunk vectors. A
//                      content-hash guard makes a no-op of MODIFYs that didn't
//                      change the text (e.g. the publish flow mirroring
//                      links/ids onto the root).
//   REMOVE          -> delete the content's vectors.
//
// Records are processed independently; a record that throws bubbles up so the
// stream retries the batch, and exhausted retries land in the configured DLQ.
export const handler = async (event) => {
  const records = event?.Records ?? [];
  for (const record of records) {
    await handleRecord(record);
  }
};

async function handleRecord(record) {
  const eventName = record.eventName;

  if (eventName === "REMOVE") {
    const oldImage = record.dynamodb?.OldImage;
    if (!oldImage) return;
    const content = unmarshall(oldImage);
    await removeContentVectors(content.tenantId, content.contentId);
    return;
  }

  // INSERT or MODIFY.
  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return;
  const content = unmarshall(newImage);

  // Defense in depth: the stream filter already restricts to Content roots, but
  // guard here too so a filter change can't silently start vectorizing other
  // entities.
  if (content.entity !== "Content") {
    logger.warn("Ignoring non-Content stream record", { entity: content.entity, sk: content.sk });
    return;
  }

  await vectorizeContent(content);
}
