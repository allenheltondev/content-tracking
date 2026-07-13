import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { ConditionalCheckFailedException, TransactionCanceledException } = await import("@aws-sdk/client-dynamodb");
const {
  voiceSampleKey,
  voiceProfileKey,
  voiceReflectionKey,
  createVoiceSample,
  listRecentSamples,
  deleteVoiceSampleRow,
  setVoiceSampleMuted,
  setVoiceSteering,
  countSampleOnce,
  getVoiceProfile,
  listProfiles,
  putVoiceProfile,
  createReflection,
  listReflections,
} = await import("../domain/voice.mjs");
const { NotFoundError } = await import("../services/errors.mjs");

const input = (mockSend, i = 0) => mockSend.mock.calls[i][0].input;
const TENANT = "tenant-sub-1";

describe("domain/voice", () => {
  let mockSend;
  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  test("key helpers scope under the tenant partition", () => {
    const pk = `TENANT#${TENANT}`;
    expect(voiceSampleKey(TENANT, "x", "S1")).toEqual({ pk, sk: "VOICE#SAMPLE#x#S1" });
    expect(voiceProfileKey(TENANT, "x")).toEqual({ pk, sk: "VOICE#PROFILE#x" });
    expect(voiceReflectionKey(TENANT, "x", "R1")).toEqual({ pk, sk: "VOICE#REFLECTION#x#R1" });
  });

  test("createVoiceSample writes a VoiceSample with a deterministic id when given", async () => {
    mockSend.mockResolvedValue({});
    const item = await createVoiceSample(TENANT, {
      text: "hi", platform: "x", format: "social", source: "manual", sampleId: "FIXED",
    });
    expect(item.entity).toBe("VoiceSample");
    expect(item.sampleId).toBe("FIXED");
    expect(item.sk).toBe("VOICE#SAMPLE#x#FIXED");
    expect(item.createdAt).toBeDefined();
    expect(input(mockSend).Item.entity).toBe("VoiceSample");
  });

  test("createVoiceSample mints a ULID when none provided", async () => {
    mockSend.mockResolvedValue({});
    const item = await createVoiceSample(TENANT, { text: "hi", platform: "x", format: "social" });
    expect(item.sampleId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(item.source).toBe("manual");
  });

  test("createVoiceSample stores publishedAt when given, omits it otherwise", async () => {
    mockSend.mockResolvedValue({});
    const dated = await createVoiceSample(TENANT, { text: "hi", platform: "blog", format: "blog", publishedAt: "2026-07-10" });
    expect(dated.publishedAt).toBe("2026-07-10");
    const undated = await createVoiceSample(TENANT, { text: "hi", platform: "x", format: "social" });
    expect(undated).not.toHaveProperty("publishedAt");
  });

  test("listRecentSamples reads the whole prefix and sorts by the recency anchor", async () => {
    // Two pages: sk order interleaves deterministic (CONTENT-...) and ULID ids,
    // so recency must come from publishedAt ?? createdAt, not the Query order.
    mockSend.mockResolvedValueOnce({
      Items: [
        { sampleId: "CONTENT-OLD", publishedAt: "2024-01-01" },
        { sampleId: "CONTENT-NEW", publishedAt: "2026-07-10" },
      ],
      LastEvaluatedKey: { pk: "p", sk: "s" },
    });
    mockSend.mockResolvedValueOnce({
      Items: [{ sampleId: "MANUAL", createdAt: "2026-06-01T00:00:00.000Z" }],
    });

    const out = await listRecentSamples(TENANT, "linkedin", 7);

    const first = input(mockSend, 0);
    expect(first.KeyConditionExpression).toContain("begins_with(sk, :prefix)");
    expect(first.ExpressionAttributeValues[":prefix"]).toBe("VOICE#SAMPLE#linkedin#");
    expect(first.Limit).toBeUndefined();
    expect(input(mockSend, 1).ExclusiveStartKey).toEqual({ pk: "p", sk: "s" });
    expect(out.map((s) => s.sampleId)).toEqual(["CONTENT-NEW", "MANUAL", "CONTENT-OLD"]);
  });

  test("listRecentSamples slices to the limit after sorting", async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { sampleId: "A", publishedAt: "2024-01-01" },
        { sampleId: "B", publishedAt: "2026-07-01" },
        { sampleId: "C", publishedAt: "2025-06-01" },
      ],
    });
    const out = await listRecentSamples(TENANT, "x", 2);
    expect(out.map((s) => s.sampleId)).toEqual(["B", "C"]);
  });

  test("countSampleOnce marks + counts atomically and returns the new count", async () => {
    mockSend.mockResolvedValueOnce({}); // TransactWrite
    mockSend.mockResolvedValueOnce({ Item: { samplesSinceReflection: 3 } }); // consistent read

    const res = await countSampleOnce(TENANT, "x", "S1");
    expect(res).toEqual({ counted: true, count: 3 });

    const txn = input(mockSend, 0);
    expect(txn.TransactItems).toHaveLength(2);
    expect(txn.TransactItems[0].Update.ConditionExpression).toBe("attribute_not_exists(vectorizedAt)");
    expect(txn.TransactItems[1].Update.UpdateExpression).toContain("ADD samplesSinceReflection :one");
    expect(input(mockSend, 1).ConsistentRead).toBe(true);
  });

  test("countSampleOnce returns counted:false when the sample was already counted", async () => {
    const cancelled = new TransactionCanceledException({ $metadata: {}, message: "cancelled" });
    cancelled.CancellationReasons = [{ Code: "ConditionalCheckFailed" }, { Code: "None" }];
    mockSend.mockRejectedValueOnce(cancelled);

    expect(await countSampleOnce(TENANT, "x", "S1")).toEqual({ counted: false, count: 0 });
    expect(mockSend).toHaveBeenCalledTimes(1); // no consistent read on the skip path
  });

  test("countSampleOnce rethrows a transient cancellation (e.g. conflict)", async () => {
    const cancelled = new TransactionCanceledException({ $metadata: {}, message: "conflict" });
    cancelled.CancellationReasons = [{ Code: "TransactionConflict" }];
    mockSend.mockRejectedValueOnce(cancelled);
    await expect(countSampleOnce(TENANT, "x", "S1")).rejects.toThrow(TransactionCanceledException);
  });

  test("putVoiceProfile resets the counter, sets version, preserves createdAt + steering", async () => {
    mockSend.mockResolvedValue({});
    const item = await putVoiceProfile(TENANT, "x", { profile: { tone: "wry" }, version: 2, createdAt: "t0", steering: "be concise" });
    expect(item.samplesSinceReflection).toBe(0);
    expect(item.version).toBe(2);
    expect(item.createdAt).toBe("t0");
    expect(item.steering).toBe("be concise");
    expect(item.entity).toBe("VoiceProfile");
    // No steering → the attribute is omitted, not written as undefined.
    mockSend.mockResolvedValue({});
    const bare = await putVoiceProfile(TENANT, "x", { profile: {}, version: 1 });
    expect(bare).not.toHaveProperty("steering");
  });

  test("setVoiceSampleMuted sets the flag, and clears it via REMOVE", async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { sampleId: "S1", muted: true } });
    const muted = await setVoiceSampleMuted(TENANT, "x", "S1", true);
    expect(muted.muted).toBe(true);
    expect(input(mockSend, 0).UpdateExpression).toBe("SET muted = :m");
    expect(input(mockSend, 0).ConditionExpression).toBe("attribute_exists(sk)");

    mockSend.mockResolvedValueOnce({ Attributes: { sampleId: "S1" } });
    await setVoiceSampleMuted(TENANT, "x", "S1", false);
    expect(input(mockSend, 1).UpdateExpression).toBe("REMOVE muted");
    expect(input(mockSend, 1).ExpressionAttributeValues).toBeUndefined();
  });

  test("setVoiceSampleMuted throws NotFound when the sample is absent", async () => {
    mockSend.mockRejectedValueOnce(new ConditionalCheckFailedException({ $metadata: {}, message: "no" }));
    await expect(setVoiceSampleMuted(TENANT, "x", "S9", true)).rejects.toThrow(NotFoundError);
  });

  test("setVoiceSteering upserts the note on the profile row (and clears with null)", async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { platform: "x", steering: "be concise" } });
    const row = await setVoiceSteering(TENANT, "x", "be concise");
    expect(row.steering).toBe("be concise");
    const cmd = input(mockSend, 0);
    expect(cmd.Key).toEqual(voiceProfileKey(TENANT, "x"));
    expect(cmd.UpdateExpression).toContain("steering = :s");
    expect(cmd.ExpressionAttributeValues[":s"]).toBe("be concise");

    mockSend.mockResolvedValueOnce({ Attributes: { platform: "x" } });
    await setVoiceSteering(TENANT, "x", null);
    expect(input(mockSend, 1).UpdateExpression).toContain("REMOVE steering");
    expect(input(mockSend, 1).ExpressionAttributeValues).not.toHaveProperty(":s");
  });

  test("getVoiceProfile / listProfiles return null|items", async () => {
    mockSend.mockResolvedValueOnce({ Item: { platform: "x" } });
    expect(await getVoiceProfile(TENANT, "x")).toEqual({ platform: "x" });
    mockSend.mockResolvedValueOnce({});
    expect(await getVoiceProfile(TENANT, "y")).toBeNull();
    mockSend.mockResolvedValueOnce({ Items: [{ platform: "x" }] });
    expect(await listProfiles(TENANT)).toEqual([{ platform: "x" }]);
  });

  test("deleteVoiceSampleRow throws NotFound when the row is absent", async () => {
    mockSend.mockRejectedValueOnce(new ConditionalCheckFailedException({ $metadata: {}, message: "no" }));
    await expect(deleteVoiceSampleRow(TENANT, "x", "S9")).rejects.toThrow(NotFoundError);
  });

  test("createReflection + listReflections", async () => {
    mockSend.mockResolvedValueOnce({});
    const r = await createReflection(TENANT, "x", { changeSummary: "c", sampleWindow: 5, model: "m", halfLifeDays: 90, version: 7, portrait: "You write plainly." });
    expect(r.entity).toBe("VoiceReflection");
    expect(r.changeSummary).toBe("c");
    expect(r.halfLifeDays).toBe(90);
    expect(r.version).toBe(7);
    expect(r.portrait).toBe("You write plainly.");

    mockSend.mockResolvedValueOnce({ Items: [{ reflectionId: "R1" }] });
    const list = await listReflections(TENANT, "x", 3);
    expect(input(mockSend, 1).ExpressionAttributeValues[":prefix"]).toBe("VOICE#REFLECTION#x#");
    expect(list).toEqual([{ reflectionId: "R1" }]);
  });
});
