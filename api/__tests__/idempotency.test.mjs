import { jest } from "@jest/globals";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";

process.env.TABLE_NAME = "test-booked";
process.env.AWS_REGION = "us-east-1";

// In-memory stand-in for the idempotency rows Powertools writes through the
// low-level client: PutItem claims a key (conditionally), UpdateItem stores
// the result, DeleteItem releases a failed claim.
const rows = new Map();
const keyOf = (key) => `${key.pk.S}|${key.sk.S}`;
jest.spyOn(DynamoDBClient.prototype, "send").mockImplementation(async (command) => {
  const name = command.constructor.name;
  const input = command.input;
  if (name === "PutItemCommand") {
    const k = keyOf(input.Item);
    const existing = rows.get(k);
    if (existing) {
      throw new ConditionalCheckFailedException({ message: "exists", $metadata: {}, Item: existing });
    }
    rows.set(k, input.Item);
    return {};
  }
  if (name === "UpdateItemCommand") {
    const k = keyOf(input.Key);
    const row = { ...rows.get(k) };
    for (const [placeholder, attr] of Object.entries(input.ExpressionAttributeNames ?? {})) {
      const valueKey = `:${placeholder.slice(1)}`;
      if (input.ExpressionAttributeValues?.[valueKey]) row[attr] = input.ExpressionAttributeValues[valueKey];
    }
    rows.set(k, row);
    return {};
  }
  if (name === "DeleteItemCommand") {
    rows.delete(keyOf(input.Key));
    return {};
  }
  throw new Error(`unexpected ${name}`);
});

const { runOnce } = await import("../services/idempotency.mjs");

beforeEach(() => rows.clear());

describe("services/idempotency runOnce", () => {
  test("runs every time when no key is supplied", async () => {
    const run = jest.fn().mockResolvedValue({ id: 1 });
    await runOnce({ operation: "op", tenantId: "t", fields: { a: 1 }, run });
    await runOnce({ operation: "op", tenantId: "t", fields: { a: 1 }, run });
    expect(run).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(0);
  });

  test("returns the stored result for a repeated key", async () => {
    const run = jest.fn().mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce({ id: 2 });
    const args = { operation: "create_campaign", tenantId: "t", idempotencyKey: "k", fields: { a: 1 } };
    const first = await runOnce({ ...args, run });
    const second = await runOnce({ ...args, run });
    expect(first).toEqual({ id: 1 });
    expect(second).toEqual({ id: 1 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("keys are scoped by operation and tenant", async () => {
    const run = jest.fn().mockResolvedValue({ ok: true });
    await runOnce({ operation: "a", tenantId: "t1", idempotencyKey: "k", fields: {}, run });
    await runOnce({ operation: "b", tenantId: "t1", idempotencyKey: "k", fields: {}, run });
    await runOnce({ operation: "a", tenantId: "t2", idempotencyKey: "k", fields: {}, run });
    expect(run).toHaveBeenCalledTimes(3);
  });

  test("rejects a reused key with different fields", async () => {
    const run = jest.fn().mockResolvedValue({ ok: true });
    const base = { operation: "op", tenantId: "t", idempotencyKey: "k", run };
    await runOnce({ ...base, fields: { a: 1 } });
    await expect(runOnce({ ...base, fields: { a: 2 } })).rejects.toMatchObject({
      name: "IdempotencyValidationError",
    });
  });

  test("releases the key when the work fails so a retry can run", async () => {
    const run = jest.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ok: true });
    const args = { operation: "op", tenantId: "t", idempotencyKey: "k", fields: {}, run };
    await expect(runOnce(args)).rejects.toThrow("boom");
    await expect(runOnce(args)).resolves.toEqual({ ok: true });
  });
});
