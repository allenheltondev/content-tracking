import { jest } from "@jest/globals";

process.env.VECTOR_BUCKET_NAME = "test-vectors";
process.env.VOICE_VECTOR_INDEX_NAME = "voice-samples";

const { S3VectorsClient } = await import("@aws-sdk/client-s3vectors");
const { voiceVectorKey, putVoiceSample, queryVoiceSamples, deleteVoiceSample } =
  await import("../services/voice-vectors.mjs");

describe("services/voice-vectors", () => {
  let mockSend;
  beforeEach(() => {
    mockSend = jest.fn();
    S3VectorsClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  test("vectorKey is `${tenantId}#${platform}#${sampleId}`", () => {
    expect(voiceVectorKey("T1", "x", "S1")).toBe("T1#x#S1");
  });

  test("putVoiceSample upserts one vector with filterable + non-filterable metadata", async () => {
    mockSend.mockResolvedValue({});
    await putVoiceSample({ tenantId: "T1", platform: "x", format: "social", sampleId: "S1", text: "hi", embedding: [0.1, 0.2] });
    const v = mockSend.mock.calls[0][0].input.vectors[0];
    expect(v.key).toBe("T1#x#S1");
    expect(v.data).toEqual({ float32: [0.1, 0.2] });
    expect(v.metadata).toEqual({ tenantId: "T1", platform: "x", format: "social", text: "hi" });
  });

  test("putVoiceSample carries publishedAt in the metadata when known", async () => {
    mockSend.mockResolvedValue({});
    await putVoiceSample({
      tenantId: "T1", platform: "blog", format: "blog", sampleId: "S1",
      text: "hi", embedding: [0.1], publishedAt: "2026-07-10",
    });
    expect(mockSend.mock.calls[0][0].input.vectors[0].metadata).toEqual({
      tenantId: "T1", platform: "blog", format: "blog", text: "hi", publishedAt: "2026-07-10",
    });
  });

  test("queryVoiceSamples filters by tenant+platform and maps results (incl. publishedAt)", async () => {
    mockSend.mockResolvedValue({
      vectors: [{ key: "T1#x#S1", distance: 0.2, metadata: { text: "body", format: "social", publishedAt: "2026-07-10" } }],
    });
    const out = await queryVoiceSamples({ tenantId: "T1", queryEmbedding: [0.1], platform: "x", topK: 3 });
    const cmd = mockSend.mock.calls[0][0].input;
    expect(cmd.indexName).toBe("voice-samples");
    expect(cmd.topK).toBe(3);
    expect(cmd.filter).toEqual({ $and: [{ tenantId: "T1" }, { platform: "x" }] });
    expect(cmd.returnMetadata).toBe(true);
    expect(out).toEqual([{ key: "T1#x#S1", distance: 0.2, text: "body", format: "social", publishedAt: "2026-07-10" }]);
  });

  test("queryVoiceSamples requires tenantId and platform", async () => {
    await expect(queryVoiceSamples({ queryEmbedding: [0.1], platform: "x" })).rejects.toThrow(/tenantId/);
    await expect(queryVoiceSamples({ tenantId: "T1", queryEmbedding: [0.1] })).rejects.toThrow(/platform/);
  });

  test("deleteVoiceSample deletes by computed key", async () => {
    mockSend.mockResolvedValue({});
    await deleteVoiceSample({ tenantId: "T1", platform: "x", sampleId: "S1" });
    expect(mockSend.mock.calls[0][0].input.keys).toEqual(["T1#x#S1"]);
  });
});
