import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond } from "./utils/response.mjs";
import { formatVendor } from "./utils/vendor.mjs";

const ddb = new DynamoDBClient();

// Personal-scale tool with low vendor cardinality — Scan with a filter is
// fine here. If this ever needs a GSI, switch the filter for a Query
// against an EntityIndex (`entity` partition).
export const handler = async (event) => {
  const limitRaw = event.queryStringParameters?.limit;
  const startKeyRaw = event.queryStringParameters?.startKey;

  let limit = 100;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      return respond(400, "limit must be an integer between 1 and 500");
    }
    limit = parsed;
  }

  let exclusiveStartKey;
  if (startKeyRaw) {
    try {
      exclusiveStartKey = JSON.parse(Buffer.from(startKeyRaw, "base64").toString("utf8"));
    } catch {
      return respond(400, "startKey is not a valid base64-encoded JSON pagination token");
    }
  }

  const result = await ddb.send(new ScanCommand({
    TableName: process.env.TABLE_NAME,
    FilterExpression: "#entity = :v AND #sk = :metadata",
    ExpressionAttributeNames: { "#entity": "entity", "#sk": "sk" },
    ExpressionAttributeValues: marshall({ ":v": "Vendor", ":metadata": "METADATA" }),
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
  }));

  const vendors = (result.Items || []).map((item) => formatVendor(unmarshall(item)));

  const nextStartKey = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64")
    : null;

  return respond(200, { vendors, nextStartKey });
};
