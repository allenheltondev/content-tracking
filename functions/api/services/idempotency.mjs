import {
  IdempotencyConfig,
  makeIdempotent,
} from "@aws-lambda-powertools/idempotency";
import { DynamoDBPersistenceLayer } from "@aws-lambda-powertools/idempotency/dynamodb";
import { TABLE_NAME } from "./ddb.mjs";

// Idempotency records live in the main table under a constant partition
// `IDEMPOTENCY` with the idempotency hash as the sort key. Records carry
// an `expiresAt` epoch-seconds attribute that DynamoDB TTL prunes.
// Mixing them into the main table (vs a separate one) follows OGF's
// pattern and keeps the infra simple.
//
// The Idempotency-Key request header is the source of the idempotency
// hash. POST routes wrap their handlers in `withIdempotency(...)` so
// retries with the same header return the cached response without
// re-executing side effects.

const persistence = new DynamoDBPersistenceLayer({
  tableName: TABLE_NAME,
  // staticPkValue + sortKeyAttr together mean: pk is fixed to
  // "IDEMPOTENCY", and the idempotency hash goes into the sk attribute.
  keyAttr: "pk",
  staticPkValue: "IDEMPOTENCY",
  sortKeyAttr: "sk",
  expiryAttr: "expiresAt",
  inProgressExpiryAttr: "inProgressExpiresAt",
  statusAttr: "status",
  dataAttr: "data",
  validationKeyAttr: "validation",
});

const config = new IdempotencyConfig({
  // JMESPath against the API Gateway event. Header lookups in
  // API Gateway are case-sensitive; OGF handles both casings the same
  // way.
  eventKeyJmesPath: 'headers."Idempotency-Key" || headers."idempotency-key"',
  // Header is required on POST routes that opt into idempotency. The
  // wrapper below catches the resulting error and surfaces it as 400.
  throwOnNoIdempotencyKey: true,
  expiresAfterSeconds: 24 * 60 * 60,
});

// Wraps an async route handler so calls with the same Idempotency-Key
// header return the cached response.
//
// Usage:
//   app.post("/campaigns", withIdempotency(async ({ event }) => { ... }));
//
// dataIndexArgument: 0 — the JMESPath above runs against the first
// argument of the wrapped function, which is the Router event object
// (since route handlers receive ({ event, context })).
export function withIdempotency(fn) {
  return makeIdempotent(fn, {
    persistenceStore: persistence,
    config,
    dataIndexArgument: 0,
  });
}
