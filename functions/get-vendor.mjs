import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond } from "./utils/response.mjs";
import { formatVendor } from "./utils/vendor.mjs";

const ddb = new DynamoDBClient();

export const handler = async (event) => {
  const vendorId = event.pathParameters?.vendorId;
  if (!vendorId) {
    return respond(400, "vendorId path parameter is required");
  }

  const result = await ddb.send(new GetItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: marshall({ pk: `VENDOR#${vendorId}`, sk: "METADATA" }),
  }));

  if (!result.Item) {
    return respond(404, `Vendor ${vendorId} not found`);
  }

  return respond(200, formatVendor(unmarshall(result.Item)));
};
