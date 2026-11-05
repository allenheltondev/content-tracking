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
// re-executing side effects. The header is optional: requests without
// it just execute normally with no idempotency record written.

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
  // JMESPath against the wrapped Router reqCtx (the first argument of
  // route handlers). The Router nests the API Gateway event one level
  // deep at `.event`, so headers live at `event.headers.*` rather than
  // at the root. Both casings handled because API Gateway header
  // lookups are case-sensitive.
  eventKeyJmesPath: 'event.headers."Idempotency-Key" || event.headers."idempotency-key"',
  // Header is optional. When absent, makeIdempotent skips the
  // DynamoDB write and just executes the handler.
  throwOnNoIdempotencyKey: false,
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

// Idempotency for non-HTTP callers (the MCP tools), keyed on an explicit
// key the caller supplies instead of a request header. The wrapped function
// takes a single object carrying `tenantId` and `idempotencyKey`; both feed
// the hash so two tenants that pick the same key never share a record.
//
// Only wrap calls that actually carry a key. The tenantId alone would hash
// to the same record on every call, so a keyless call must skip the wrapper
// and run directly.
const keyedConfig = new IdempotencyConfig({
  eventKeyJmesPath: "[tenantId, idempotencyKey]",
  // Reusing a key with different arguments raises
  // IdempotencyValidationError instead of silently returning the first
  // call's result.
  payloadValidationJmesPath: "fields",
  throwOnNoIdempotencyKey: true,
  expiresAfterSeconds: 24 * 60 * 60,
});

export function withKeyedIdempotency(fn) {
  return makeIdempotent(fn, {
    persistenceStore: persistence,
    config: keyedConfig,
    dataIndexArgument: 0,
  });
}
