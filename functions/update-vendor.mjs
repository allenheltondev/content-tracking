import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond } from "./utils/response.mjs";
import { formatVendor, validateVendorPayload } from "./utils/vendor.mjs";

const ddb = new DynamoDBClient();

export const handler = async (event) => {
  const vendorId = event.pathParameters?.vendorId;
  if (!vendorId) {
    return respond(400, "vendorId path parameter is required");
  }

  if (!event.body) {
    return respond(400, "Missing request body");
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, "Invalid JSON body");
  }

  const validation = validateVendorPayload(body, { requireName: false });
  if (!validation.ok) {
    return respond(400, validation.message);
  }
  const fields = validation.value;

  if (Object.keys(fields).length === 0) {
    return respond(400, "request body must contain at least one updatable field");
  }

  // Build the UpdateItem expression dynamically. SET clauses for fields
  // present in the payload, REMOVE clauses for explicit nulls so the
  // caller can clear an optional field.
  const setClauses = [];
  const removeClauses = [];
  const names = { "#updatedAt": "updatedAt" };
  const values = { ":updatedAt": new Date().toISOString() };

  for (const [key, value] of Object.entries(fields)) {
    const placeholder = `#${key}`;
    names[placeholder] = key;
    if (value === null) {
      removeClauses.push(placeholder);
    } else {
      const valuePlaceholder = `:${key}`;
      values[valuePlaceholder] = value;
      setClauses.push(`${placeholder} = ${valuePlaceholder}`);
    }
  }

  setClauses.push("#updatedAt = :updatedAt");

  let updateExpression = `SET ${setClauses.join(", ")}`;
  if (removeClauses.length > 0) {
    updateExpression += ` REMOVE ${removeClauses.join(", ")}`;
  }

  let result;
  try {
    result = await ddb.send(new UpdateItemCommand({
      TableName: process.env.TABLE_NAME,
      Key: marshall({ pk: `VENDOR#${vendorId}`, sk: "METADATA" }),
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
      ConditionExpression: "attribute_exists(pk)",
      ReturnValues: "ALL_NEW",
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return respond(404, `Vendor ${vendorId} not found`);
    }
    throw err;
  }

  return respond(200, formatVendor(unmarshall(result.Attributes)));
};
