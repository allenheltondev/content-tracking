import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { ulid } from "ulid";
import { respond } from "./utils/response.mjs";
import { formatVendor, validateVendorPayload } from "./utils/vendor.mjs";

const ddb = new DynamoDBClient();

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

  const validation = validateVendorPayload(body, { requireName: true });
  if (!validation.ok) {
    return respond(400, validation.message);
  }
  const fields = validation.value;

  const vendorId = ulid();
  const createdAt = new Date().toISOString();

  const item = {
    pk: `VENDOR#${vendorId}`,
    sk: "METADATA",
    entity: "Vendor",
    vendorId,
    createdAt,
    updatedAt: createdAt,
    ...fields,
  };

  await ddb.send(new PutItemCommand({
    TableName: process.env.TABLE_NAME,
    Item: marshall(item, { removeUndefinedValues: true }),
    ConditionExpression: "attribute_not_exists(pk)",
  }));

  return respond(201, formatVendor(item));
};
