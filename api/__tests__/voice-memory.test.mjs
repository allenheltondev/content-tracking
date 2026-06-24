import { jest } from "@jest/globals";

// Threshold is read at module load — set it low so a single bump can cross it.
process.env.REFLECTION_THRESHOLD = "3";
process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";

jest.unstable_mockModule("../services/embeddings.mjs", () => ({ embedText: jest.fn() }));
jest.unstable_mockModule("../services/voice-vectors.mjs", () => ({ putVoiceSample: jest.fn() }));
jest.unstable_mockModule("../services/bedrock.mjs", () => ({ reflectVoiceProfile: jest.fn() }));
jest.unstable_mockModule("../domain/voice.mjs", () => ({
  countSampleOnce: jest.fn(),
  listRecentSamples: jest.fn(),
  getVoiceProfile: jest.fn(),
  putVoiceProfile: jest.fn(),
  createReflection: jest.fn(),
}));

const { embedText } = await import("../services/embeddings.mjs");
const { putVoiceSample } = await import("../services/voice-vectors.mjs");
const { reflectVoiceProfile } = await import("../services/bedrock.mjs");
const {
  countSampleOnce, listRecentSamples,
  getVoiceProfile, putVoiceProfile, createReflection,
} = await import("../domain/voice.mjs");
const { recordVoiceSample, runReflection } = await import("../services/voice-memory.mjs");

const sample = { tenantId: "T1", platform: "x", sampleId: "S1", format: "social", text: "hello world" };

beforeEach(() => {
  jest.clearAllMocks();
  embedText.mockResolvedValue([0.1, 0.2]);
  putVoiceSample.mockResolvedValue();
  countSampleOnce.mockResolvedValue({ counted: true, count: 1 });
  listRecentSamples.mockResolvedValue([{ text: "a" }, { text: "b" }]);
  getVoiceProfile.mockResolvedValue(null);
  reflectVoiceProfile.mockResolvedValue({ profile: { tone: "wry" }, change_summary: "built it" });
  putVoiceProfile.mockResolvedValue({});
  createReflection.mockResolvedValue({});
});

describe("recordVoiceSample", () => {
  test("embeds, upserts, and counts — no reflection below threshold", async () => {
    countSampleOnce.mockResolvedValue({ counted: true, count: 2 });
    const res = await recordVoiceSample(sample);
    expect(res).toEqual({ count: 2 });
    expect(embedText).toHaveBeenCalledWith("hello world");
    expect(putVoiceSample).toHaveBeenCalledTimes(1);
    expect(countSampleOnce).toHaveBeenCalledWith("T1", "x", "S1");
    expect(reflectVoiceProfile).not.toHaveBeenCalled();
  });

  test("triggers reflection once the counter reaches the threshold", async () => {
    countSampleOnce.mockResolvedValue({ counted: true, count: 3 });
    await recordVoiceSample(sample);
    expect(reflectVoiceProfile).toHaveBeenCalledTimes(1);
    expect(putVoiceProfile).toHaveBeenCalledWith("T1", "x", expect.objectContaining({ version: 1 }));
    expect(createReflection).toHaveBeenCalledTimes(1);
  });

  test("redelivery (already counted) skips reflection but re-puts the vector", async () => {
    countSampleOnce.mockResolvedValue({ counted: false, count: 0 });
    const res = await recordVoiceSample(sample);
    expect(res).toEqual({ skipped: true, reason: "already-counted" });
    expect(putVoiceSample).toHaveBeenCalledTimes(1); // idempotent re-put still happens
    expect(reflectVoiceProfile).not.toHaveBeenCalled();
  });

  test("skips a sample missing required fields", async () => {
    const res = await recordVoiceSample({ tenantId: "T1", platform: "x" });
    expect(res.skipped).toBe(true);
    expect(embedText).not.toHaveBeenCalled();
  });
});

describe("runReflection", () => {
  test("bumps version off the prior profile and records the reflection", async () => {
    getVoiceProfile.mockResolvedValue({ profile: { tone: "old" }, version: 4, createdAt: "t0" });
    await runReflection("T1", "x");
    expect(reflectVoiceProfile).toHaveBeenCalledWith({
      platform: "x", currentProfile: { tone: "old" }, samples: [{ text: "a" }, { text: "b" }],
    });
    expect(putVoiceProfile).toHaveBeenCalledWith("T1", "x", { profile: { tone: "wry" }, version: 5, createdAt: "t0" });
    expect(createReflection).toHaveBeenCalledWith("T1", "x", expect.objectContaining({ sampleWindow: 2 }));
  });

  test("returns null and skips Bedrock when there are no samples", async () => {
    listRecentSamples.mockResolvedValue([]);
    expect(await runReflection("T1", "x")).toBeNull();
    expect(reflectVoiceProfile).not.toHaveBeenCalled();
  });
});
