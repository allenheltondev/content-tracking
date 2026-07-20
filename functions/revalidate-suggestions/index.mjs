import { unmarshall } from "@aws-sdk/util-dynamodb";
import { logger } from "../../api/services/logger.mjs";
import { revalidateSuggestions } from "../../api/domain/content-review.mjs";

// DynamoDB-stream-driven suggestion revalidation. A third event-source mapping
// on the shared table stream (alongside VectorizeContentFunction and
// VoiceMemoryFunction), filtered in template.yaml to Content ROOT *edits*
// (MODIFY, entity = "Content"). When a creator edits a draft that has an open
// review, pending suggestions can fall out of sync with the text: this keeps
// still-valid ones anchored to the new body (re-locating their offsets) and
// marks ones the edit removed as `skipped`, so the editor shows exactly the
// suggestions that still apply.
//
// Only MODIFY reaches us — INSERT can't have suggestions yet, and REMOVE is
// handled by deleteContent's cascade. The body-unchanged case (e.g. the publish
// flow mirroring links/ids onto the root, or a title-only edit) is a cheap no-op
// here because we compare the old and new body first. Revalidation writes only
// SUGGESTION child rows (entity = ContentSuggestion), which this filter never
// matches, so it can't re-trigger itself.
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
  if (record.eventName !== "MODIFY") return;

  const newImage = record.dynamodb?.NewImage;
  const oldImage = record.dynamodb?.OldImage;
  if (!newImage) return;

  const content = unmarshall(newImage);

  // Defense in depth: the stream filter already restricts to Content roots, but
  // guard here too so a filter change can't silently start revalidating against
  // other entities.
  if (content.entity !== "Content") {
    logger.warn("Ignoring non-Content stream record", { entity: content.entity, sk: content.sk });
    return;
  }

  // Only a body change can invalidate a suggestion's anchor. Skip title/link/id
  // edits so an unrelated MODIFY doesn't churn every pending suggestion.
  const oldBody = oldImage ? unmarshall(oldImage).contentMarkdown : undefined;
  const newBody = content.contentMarkdown;
  if (oldBody === newBody) return;

  const { kept, skipped } = await revalidateSuggestions(
    content.tenantId,
    content.contentId,
    typeof newBody === "string" ? newBody : "",
    { contentVersion: content.updatedAt },
  );

  if (kept > 0 || skipped > 0) {
    logger.info("Revalidated suggestions after content edit", {
      tenantId: content.tenantId,
      contentId: content.contentId,
      kept,
      skipped,
    });
  }
}
