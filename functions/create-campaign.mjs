import { DynamoDBClient, TransactWriteItemsCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { ulid } from "ulid";
import { respond } from "./utils/response.mjs";
import { formatPayout, validatePayoutPayload } from "./utils/payout.mjs";

const ddb = new DynamoDBClient();

const VALID_STATUSES = new Set(["draft", "active", "completed"]);
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const handler = async (event) => {
  if (!event.body) {
    return respond(400, "Missing request body");
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, "Invalid JSON body");
  }

  const { name, sponsor, vendor_id, startDate, endDate, status, targetMetrics, payout } = body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return respond(400, "name is required");
  }
  if (name.length > 200) {
    return respond(400, "name exceeds 200 chars");
  }
  if (sponsor !== undefined && sponsor !== null && (typeof sponsor !== "string" || sponsor.length > 200)) {
    return respond(400, "sponsor must be a string up to 200 chars");
  }
  if (vendor_id !== undefined && vendor_id !== null) {
    if (typeof vendor_id !== "string" || !ULID_RE.test(vendor_id)) {
      return respond(400, "vendor_id must be a ULID");
    }
  }
  if (status !== undefined && !VALID_STATUSES.has(status)) {
    return respond(400, `status must be one of ${[...VALID_STATUSES].join(", ")}`);
  }
  if (startDate !== undefined && !isIsoDate(startDate)) {
    return respond(400, "startDate must be YYYY-MM-DD");
  }
  if (endDate !== undefined && !isIsoDate(endDate)) {
    return respond(400, "endDate must be YYYY-MM-DD");
  }
  if (targetMetrics !== undefined && (typeof targetMetrics !== "object" || Array.isArray(targetMetrics) || targetMetrics === null)) {
    return respond(400, "targetMetrics must be an object");
  }

  let validatedPayout;
  if (payout !== undefined && payout !== null) {
    const payoutValidation = validatePayoutPayload(payout, { partial: false });
    if (!payoutValidation.ok) {
      return respond(400, payoutValidation.message);
    }
    validatedPayout = payoutValidation.value;
  }

  // If vendor_id is supplied, confirm the vendor exists before we attempt
  // the transactional write. Returning 404 here is the only way to give a
  // useful error — a TransactionCanceledException out of a ConditionCheck
  // wouldn't tell the caller which item failed.
  if (vendor_id) {
    const vendorCheck = await ddb.send(new GetItemCommand({
      TableName: process.env.TABLE_NAME,
      Key: marshall({ pk: `VENDOR#${vendor_id}`, sk: "METADATA" }),
      ProjectionExpression: "pk",
    }));
    if (!vendorCheck.Item) {
      return respond(404, `Vendor ${vendor_id} not found`);
    }
  }

  const campaignId = ulid();
  const createdAt = new Date().toISOString();
  const finalStatus = status || "active";

  const metadata = {
    pk: `CAMPAIGN#${campaignId}`,
    sk: "METADATA",
    entity: "Campaign",
    campaignId,
    name: name.trim(),
    status: finalStatus,
    createdAt,
  };
  if (sponsor) metadata.sponsor = sponsor;
  if (vendor_id) metadata.vendorId = vendor_id;
  if (startDate) metadata.startDate = startDate;
  if (endDate) metadata.endDate = endDate;
  if (targetMetrics) metadata.targetMetrics = targetMetrics;
  if (validatedPayout) metadata.payout = validatedPayout;

  // Write the campaign metadata and, when linked to a vendor, the
  // campaign-by-vendor index entry, in a single transaction. The index
  // entry denormalizes the fields needed for vendor detail views so
  // GET /vendors/{id}/campaigns doesn't need a fan-out GetItem per
  // campaign.
  const transactItems = [
    {
      Put: {
        TableName: process.env.TABLE_NAME,
        Item: marshall(metadata, { removeUndefinedValues: true }),
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
  ];

  if (vendor_id) {
    const indexEntry = {
      pk: `VENDOR#${vendor_id}`,
      sk: `CAMPAIGN#${campaignId}`,
      entity: "CampaignByVendor",
      campaignId,
      vendorId: vendor_id,
      name: metadata.name,
      status: finalStatus,
      createdAt,
    };
    if (startDate) indexEntry.startDate = startDate;
    if (endDate) indexEntry.endDate = endDate;

    transactItems.push({
      Put: {
        TableName: process.env.TABLE_NAME,
        Item: marshall(indexEntry, { removeUndefinedValues: true }),
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
  }

  await ddb.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));

  return respond(201, {
    campaign_id: campaignId,
    name: metadata.name,
    sponsor: metadata.sponsor ?? null,
    vendor_id: metadata.vendorId ?? null,
    startDate: metadata.startDate ?? null,
    endDate: metadata.endDate ?? null,
    status: finalStatus,
    targetMetrics: metadata.targetMetrics ?? null,
    payout: formatPayout(metadata.payout),
    created_at: createdAt,
  });
};

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
