import { DynamoDBClient, DeleteItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { respond, empty } from "./utils/response.mjs";

const ddb = new DynamoDBClient();

export const handler = async (event) => {
  const vendorId = event.pathParameters?.vendorId;
  if (!vendorId) {
    return respond(400, "vendorId path parameter is required");
  }

  // Block delete if there are campaigns linked under VENDOR#{id}/CAMPAIGN#*.
  // Returning 409 with the count gives the caller something actionable
  // instead of a silent orphaning of the campaign-by-vendor index.
  const linkedCampaigns = await ddb.send(new QueryCommand({
    TableName: process.env.TABLE_NAME,
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: marshall({ ":pk": `VENDOR#${vendorId}`, ":prefix": "CAMPAIGN#" }),
    Select: "COUNT",
  }));

  if ((linkedCampaigns.Count || 0) > 0) {
    return respond(409, `Vendor ${vendorId} has ${linkedCampaigns.Count} linked campaign(s). Unlink or delete them first.`);
  }

  try {
    await ddb.send(new DeleteItemCommand({
      TableName: process.env.TABLE_NAME,
      Key: marshall({ pk: `VENDOR#${vendorId}`, sk: "METADATA" }),
      ConditionExpression: "attribute_exists(pk)",
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return respond(404, `Vendor ${vendorId} not found`);
    }
    throw err;
  }

  return empty(204);
};
