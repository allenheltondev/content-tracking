import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { ConditionalCheckFailedException } = await import("@aws-sdk/client-dynamodb");
const {
  voiceSampleKey,
  voiceProfileKey,
  voiceReflectionKey,
  createVoiceSample,
  listRecentSamples,
  deleteVoiceSampleRow,
  markSampleVectorized,
  getVoiceProfile,
  listProfiles,
  bumpSampleCounter,
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

  test("listRecentSamples queries begins_with newest-first with a limit", async () => {
    mockSend.mockResolvedValue({ Items: [{ sampleId: "S2" }] });
    const out = await listRecentSamples(TENANT, "linkedin", 7);
    const cmd = input(mockSend);
    expect(cmd.KeyConditionExpression).toContain("begins_with(sk, :prefix)");
    expect(cmd.ExpressionAttributeValues[":prefix"]).toBe("VOICE#SAMPLE#linkedin#");
    expect(cmd.ScanIndexForward).toBe(false);
    expect(cmd.Limit).toBe(7);
    expect(out).toEqual([{ sampleId: "S2" }]);
  });

  test("bumpSampleCounter ADDs and returns the new count", async () => {
    mockSend.mockResolvedValue({ Attributes: { samplesSinceReflection: 3 } });
    const count = await bumpSampleCounter(TENANT, "x");
    expect(count).toBe(3);
    const cmd = input(mockSend);
    expect(cmd.UpdateExpression).toContain("ADD samplesSinceReflection :one");
    expect(cmd.ReturnValues).toBe("UPDATED_NEW");
  });

  test("markSampleVectorized returns true on first mark, false on redelivery", async () => {
    mockSend.mockResolvedValueOnce({});
    expect(await markSampleVectorized(TENANT, "x", "S1")).toBe(true);
    expect(input(mockSend).ConditionExpression).toBe("attribute_not_exists(vectorizedAt)");

    mockSend.mockRejectedValueOnce(new ConditionalCheckFailedException({ $metadata: {}, message: "exists" }));
    expect(await markSampleVectorized(TENANT, "x", "S1")).toBe(false);
  });

  test("putVoiceProfile resets the counter, sets version, preserves createdAt", async () => {
    mockSend.mockResolvedValue({});
    const item = await putVoiceProfile(TENANT, "x", { profile: { tone: "wry" }, version: 2, createdAt: "t0" });
    expect(item.samplesSinceReflection).toBe(0);
    expect(item.version).toBe(2);
    expect(item.createdAt).toBe("t0");
    expect(item.entity).toBe("VoiceProfile");
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
    const r = await createReflection(TENANT, "x", { changeSummary: "c", sampleWindow: 5, model: "m" });
    expect(r.entity).toBe("VoiceReflection");
    expect(r.changeSummary).toBe("c");

    mockSend.mockResolvedValueOnce({ Items: [{ reflectionId: "R1" }] });
    const list = await listReflections(TENANT, "x", 3);
    expect(input(mockSend, 1).ExpressionAttributeValues[":prefix"]).toBe("VOICE#REFLECTION#x#");
    expect(list).toEqual([{ reflectionId: "R1" }]);
  });
});
