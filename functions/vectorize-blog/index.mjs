import { unmarshall } from "@aws-sdk/util-dynamodb";
import { logger } from "../../api/services/logger.mjs";
import { vectorizeBlog, removeBlogVectors } from "./vectorize.mjs";

// DynamoDB-stream-driven blog vectorizer. The event source mapping is filtered
// (in template.yaml) to records whose entity is "Blog", so this only sees blog
// ROOT inserts/modifies/deletes — never the per-platform copy rows, view
// snapshots, or its own BlogVectorIndex state row (which would otherwise loop).
//
//   INSERT / MODIFY -> (re)embed the post and upsert its chunk vectors. A
//                      content-hash guard makes a no-op of MODIFYs that didn't
//                      change the text (e.g. the cross-post flow mirroring
//                      links/ids onto the root).
//   REMOVE          -> delete the post's vectors.
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
    const blog = unmarshall(oldImage);
    await removeBlogVectors(blog.tenantId, blog.blogId);
    return;
  }

  // INSERT or MODIFY.
  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return;
  const blog = unmarshall(newImage);

  // Defense in depth: the stream filter already restricts to Blog roots, but
  // guard here too so a filter change can't silently start vectorizing other
  // entities.
  if (blog.entity !== "Blog") {
    logger.warn("Ignoring non-Blog stream record", { entity: blog.entity, sk: blog.sk });
    return;
  }

  await vectorizeBlog(blog);
}
