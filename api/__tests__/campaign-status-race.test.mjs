import { jest } from "@jest/globals";
import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

process.env.TABLE_NAME = "test-booked";

// Concurrent status moves through the real service and domain code. The
// stand-in below keeps rows in memory, evaluates the campaign row's write
// condition, and holds every write until both calls have finished their
// reads, which is the interleaving that used to reopen a completed campaign:
// both read "active", one writes "completed", the other writes "draft".
const TENANT = "tenant-1";
let rows;
let reads;
let releaseWrites;
let readsDone;

function keyOf(key) {
  return `${key.pk}|${key.sk}`;
}

function conditionHolds(row, { ConditionExpression: expr, ExpressionAttributeValues: values = {} }) {
  if (!row) return false;
  if (expr.includes(":expectedStatus")) return row.status === values[":expectedStatus"];
  if (expr.includes("attribute_not_exists(#status)")) return row.status === undefined;
  return true;
}

function applySet(row, { UpdateExpression, ExpressionAttributeNames: names, ExpressionAttributeValues: values }) {
  const assignments = UpdateExpression.replace(/^SET /, "").split(", ");
  for (const assignment of assignments) {
    const [name, value] = assignment.split(" = ");
    row[names[name]] = values[value];
  }
}

beforeEach(() => {
  rows = new Map();
  reads = 0;
  readsDone = new Promise((resolve) => { releaseWrites = resolve; });
  DynamoDBDocumentClient.prototype.send = jest.fn(async (command) => {
    const name = command.constructor.name;
    const input = command.input;
    if (name === "GetCommand") {
      reads += 1;
      if (reads >= 4) releaseWrites();
      const row = rows.get(keyOf(input.Key));
      return { Item: row ? { ...row } : undefined };
    }
    await readsDone;
    if (name === "UpdateCommand") {
      const row = rows.get(keyOf(input.Key));
      if (!conditionHolds(row, input)) {
        throw new ConditionalCheckFailedException({ message: "condition", $metadata: {} });
      }
      applySet(row, input);
      return { Attributes: { ...row } };
    }
    if (name === "TransactWriteCommand") {
      const [campaign, ...rest] = input.TransactItems.map((item) => item.Update);
      if (!conditionHolds(rows.get(keyOf(campaign.Key)), campaign)) {
        throw new TransactionCanceledException({
          message: "cancelled",
          $metadata: {},
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }, ...rest.map(() => ({ Code: "None" }))],
        });
      }
      for (const update of [campaign, ...rest]) applySet(rows.get(keyOf(update.Key)), update);
      return {};
    }
    throw new Error(`unexpected ${name}`);
  });
});

const { setCampaignStatus } = await import("../services/campaign-actions.mjs");
const { ConflictError } = await import("../services/errors.mjs");

function seed(campaign) {
  rows.set(`CAMPAIGN#C1|METADATA`, { pk: "CAMPAIGN#C1", sk: "METADATA", campaignId: "C1", tenantId: TENANT, ...campaign });
}

async function race(...moves) {
  return Promise.allSettled(moves.map((status) => setCampaignStatus(TENANT, "C1", status)));
}

describe("concurrent campaign status moves", () => {
  test("only one of two racing moves lands; the other gets a conflict", async () => {
    seed({ status: "active" });
    const [completed, draft] = await race("completed", "draft");

    expect(completed.status).toBe("fulfilled");
    expect(draft.status).toBe("rejected");
    expect(draft.reason).toBeInstanceOf(ConflictError);
    expect(draft.reason.message).toMatch(/changed to completed while this update ran/);
    // completed stays final: the losing "draft" write never applied.
    expect(rows.get("CAMPAIGN#C1|METADATA").status).toBe("completed");
  });

  test("the vendor mirror moves with the campaign, and only for the winner", async () => {
    seed({ status: "active", vendorId: "acme" });
    rows.set("VENDOR#acme|CAMPAIGN#C1", { pk: "VENDOR#acme", sk: "CAMPAIGN#C1", status: "active" });

    const [completed, draft] = await race("completed", "draft");

    expect(completed.status).toBe("fulfilled");
    expect(draft.reason).toBeInstanceOf(ConflictError);
    expect(rows.get("CAMPAIGN#C1|METADATA").status).toBe("completed");
    expect(rows.get("VENDOR#acme|CAMPAIGN#C1").status).toBe("completed");
  });

  test("a legacy row with no status is guarded as well", async () => {
    seed({});
    const [monitoring, completed] = await race("monitoring", "completed");

    expect([monitoring.status, completed.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(rows.get("CAMPAIGN#C1|METADATA").status).toBe("monitoring");
  });
});
