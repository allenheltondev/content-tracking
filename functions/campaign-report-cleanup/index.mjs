import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { s3 } from "../../api/services/s3.mjs";
import { logger } from "../../api/services/logger.mjs";

// Deletes a campaign report's HTML when DynamoDB TTL expires its record.
//
// The reports bucket's lifecycle rule expires objects a fixed number of days
// after they were last written. That matches the record TTL for a report
// written once, but superseding an older report rewrites its object (to add
// the "newer version available" banner), which restarts the lifecycle clock.
// Deleting on the record's TTL keeps the object's lifetime anchored to when
// the report was generated. The lifecycle rule stays as the backstop.
//
// template.yaml filters the stream to TTL removals (service principal
// dynamodb.amazonaws.com) of CampaignReport records; the checks below repeat
// that so a filter change can't turn this into a general-purpose deleter.

const KEY_PREFIX = "reports/campaigns/";

export const handler = async (event) => {
  for (const record of event?.Records ?? []) {
    await handleRecord(record);
  }
};

async function handleRecord(record) {
  if (record.eventName !== "REMOVE") return;
  if (record.userIdentity?.principalId !== "dynamodb.amazonaws.com") return;

  const oldImage = record.dynamodb?.OldImage;
  if (!oldImage) return;
  const item = unmarshall(oldImage);
  if (item.entity !== "CampaignReport") return;
  if (typeof item.key !== "string" || !item.key.startsWith(KEY_PREFIX)) return;

  // DeleteObject on a key the lifecycle rule already removed succeeds, so
  // this is idempotent across retries.
  await s3.send(new DeleteObjectCommand({
    Bucket: process.env.VENDOR_REPORTS_BUCKET,
    Key: item.key,
  }));
  logger.info("Deleted expired campaign report", {
    campaignId: item.campaignId,
    reportId: item.reportId,
  });
}
