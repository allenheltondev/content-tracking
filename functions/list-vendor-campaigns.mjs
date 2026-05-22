import { DynamoDBClient, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond } from "./utils/response.mjs";

const ddb = new DynamoDBClient();

export const handler = async (event) => {
  const vendorId = event.pathParameters?.vendorId;
  if (!vendorId) {
    return respond(400, "vendorId path parameter is required");
  }

  // Confirm the vendor exists. Returning 404 here is more useful than
  // silently returning an empty list (which would also be the result if
  // the vendor doesn't exist).
  const vendor = await ddb.send(new GetItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: marshall({ pk: `VENDOR#${vendorId}`, sk: "METADATA" }),
    ProjectionExpression: "pk",
  }));
  if (!vendor.Item) {
    return respond(404, `Vendor ${vendorId} not found`);
  }

  // Query the campaign-by-vendor index entries written at campaign-create
  // time. Each entry carries the denormalized fields needed for a list
  // view so we don't have to fan out a GetItem per campaign.
  const result = await ddb.send(new QueryCommand({
    TableName: process.env.TABLE_NAME,
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: marshall({ ":pk": `VENDOR#${vendorId}`, ":prefix": "CAMPAIGN#" }),
  }));

  const campaigns = (result.Items || [])
    .map((it) => unmarshall(it))
    .map((row) => ({
      campaign_id: row.campaignId,
      name: row.name,
      status: row.status,
      startDate: row.startDate ?? null,
      endDate: row.endDate ?? null,
      created_at: row.createdAt,
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return respond(200, { vendor_id: vendorId, campaigns });
};
