import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond } from "./utils/response.mjs";
import { formatPayout, validatePayoutPayload } from "./utils/payout.mjs";

const ddb = new DynamoDBClient();

// PATCH /campaigns/{campaignId}/payout
//
// Used both to set the initial payout when it wasn't supplied at create time
// and to mark a campaign paid later. The payload is the inner payout object
// (not wrapped under `payout: { ... }`). Sub-fields obey the same null
// semantics as the rest of the API: present-with-null means clear that
// sub-field (only paid_at and invoice_ref are nullable).
//
// Top-level `null` body is not supported here — to fully remove a payout
// after the fact, a separate operation would be needed. Hasn't come up yet.
export const handler = async (event) => {
  const campaignId = event.pathParameters?.campaignId;
  if (!campaignId) {
    return respond(400, "campaignId path parameter is required");
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

  const validation = validatePayoutPayload(body, { partial: true });
  if (!validation.ok) {
    return respond(400, validation.message);
  }
  const fields = validation.value;

  if (Object.keys(fields).length === 0) {
    return respond(400, "request body must contain at least one payout field");
  }

  // Build the UpdateItem expression. Sub-fields land under the `payout` map
  // attribute on the campaign metadata item. Null values that made it through
  // validation (paid_at, invoice_ref) become REMOVE clauses on those nested
  // paths.
  const setClauses = [];
  const removeClauses = [];
  const names = { "#payout": "payout" };
  const values = {};

  // Mark-paid shortcut: if the caller sets paid=true and didn't include a
  // paid_at, populate paid_at server-side. Matches the common "mark this
  // paid today" flow described in issue #23 without forcing the client to
  // duplicate the date.
  if (fields.paid === true && fields.paid_at === undefined) {
    fields.paid_at = new Date().toISOString().slice(0, 10);
  }
  // If the caller sets paid=false explicitly, clear paid_at unless they
  // also passed one. "Unpaid with a payment date" is a contradiction.
  if (fields.paid === false && fields.paid_at === undefined) {
    fields.paid_at = null;
  }

  for (const [key, value] of Object.entries(fields)) {
    const namePlaceholder = `#${key}`;
    names[namePlaceholder] = key;
    if (value === null) {
      removeClauses.push(`#payout.${namePlaceholder}`);
    } else {
      const valuePlaceholder = `:${key}`;
      values[valuePlaceholder] = value;
      setClauses.push(`#payout.${namePlaceholder} = ${valuePlaceholder}`);
    }
  }

  // If the campaign has no existing payout, the nested SET would fail with
  // "document path provided in update expression is invalid". Default the
  // top-level map to an empty object first so partial updates work on
  // payout-less campaigns.
  const updateExpressionParts = [];
  updateExpressionParts.push(`SET #payout = if_not_exists(#payout, :empty)`);
  if (setClauses.length > 0) {
    updateExpressionParts[0] += `, ${setClauses.join(", ")}`;
  }
  if (removeClauses.length > 0) {
    updateExpressionParts.push(`REMOVE ${removeClauses.join(", ")}`);
  }
  values[":empty"] = {};

  let result;
  try {
    result = await ddb.send(new UpdateItemCommand({
      TableName: process.env.TABLE_NAME,
      Key: marshall({ pk: `CAMPAIGN#${campaignId}`, sk: "METADATA" }),
      UpdateExpression: updateExpressionParts.join(" "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
      ConditionExpression: "attribute_exists(pk)",
      ReturnValues: "ALL_NEW",
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return respond(404, `Campaign ${campaignId} not found`);
    }
    throw err;
  }

  const row = unmarshall(result.Attributes);
  return respond(200, {
    campaign_id: row.campaignId,
    name: row.name,
    sponsor: row.sponsor ?? null,
    vendor_id: row.vendorId ?? null,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    status: row.status,
    targetMetrics: row.targetMetrics ?? null,
    payout: formatPayout(row.payout),
    created_at: row.createdAt,
  });
};
