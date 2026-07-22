import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { NotFoundError } from "./errors.mjs";

// One shared client per Lambda execution environment. The Document
// client wraps the low-level DynamoDBClient and handles marshall /
// unmarshall automatically, so route + domain code can pass plain JS
// objects.
//
// Connection reuse is on by default in AWS_NODEJS_CONNECTION_REUSE_ENABLED=1
// land; Lambda Node 24 enables this implicitly.
const baseClient = new DynamoDBClient();

export const ddb = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: {
    // null over undefined: makes nullable optional fields cleaner to
    // round-trip through update operations.
    removeUndefinedValues: true,
  },
});

export const TABLE_NAME = process.env.TABLE_NAME;

// True for the failure a ConditionExpression produces. The instanceof check
// covers the real SDK error; the name check covers errors that crossed a
// bundling or mocking boundary and lost their prototype.
export function isConditionalCheckFailed(err) {
  return (
    err instanceof ConditionalCheckFailedException ||
    err?.name === "ConditionalCheckFailedException"
  );
}

// Runs a conditional write and converts a ConditionExpression failure into
// the standard 404. Every domain module's "attribute_exists guard means the
// row is gone" convention funnels through here.
export async function mapConditionalFailure(entity, id, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new NotFoundError(entity, id);
    }
    throw err;
  }
}

// Builds the expression trio for a partial item update following the house
// conventions: null clears a field (REMOVE), any other value is SET, and
// updatedAt is stamped automatically. Spread the result into an
// UpdateCommand or a TransactWrite Update item.
//
// Options:
//   skip        - Set (or array) of protected field names to ignore.
//   extraSet    - entity-specific SET clauses appended verbatim, with their
//                 placeholders supplied via extraNames/extraValues (e.g.
//                 keeping links.url in lockstep with canonicalUrl).
export function buildUpdateExpression(fields, { skip, extraSet = [], extraNames = {}, extraValues = {} } = {}) {
  const skipSet = skip instanceof Set ? skip : new Set(skip ?? []);
  const names = { "#updatedAt": "updatedAt", ...extraNames };
  const values = { ":updatedAt": new Date().toISOString(), ...extraValues };
  const setClauses = ["#updatedAt = :updatedAt"];
  const removeClauses = [];

  for (const [key, value] of Object.entries(fields)) {
    if (skipSet.has(key)) continue;
    const namePlaceholder = `#${key}`;
    names[namePlaceholder] = key;
    if (value === null) {
      removeClauses.push(namePlaceholder);
    } else {
      values[`:${key}`] = value;
      setClauses.push(`${namePlaceholder} = :${key}`);
    }
  }
  setClauses.push(...extraSet);

  let updateExpression = `SET ${setClauses.join(", ")}`;
  if (removeClauses.length > 0) {
    updateExpression += ` REMOVE ${removeClauses.join(", ")}`;
  }

  return {
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}
