import { jest } from "@jest/globals";

// Threshold is read at module load — set it low so a single bump can cross it.
process.env.REFLECTION_THRESHOLD = "3";
process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.VOICE_HALF_LIFE_DAYS = "90";

jest.unstable_mockModule("../services/embeddings.mjs", () => ({ embedText: jest.fn() }));
jest.unstable_mockModule("../services/voice-vectors.mjs", () => ({
  putVoiceSample: jest.fn(),
  deleteVoiceSample: jest.fn(),
}));
jest.unstable_mockModule("../services/bedrock.mjs", () => ({ reflectVoiceProfile: jest.fn() }));
jest.unstable_mockModule("../services/reflection-queue.mjs", () => ({ enqueueReflectionCatchup: jest.fn() }));
jest.unstable_mockModule("../domain/voice.mjs", () => ({
  claimReflectionSlot: jest.fn(),
  countSampleOnce: jest.fn(),
  createVoiceSample: jest.fn(),
  deleteVoiceSampleRow: jest.fn(),
  listRecentSamples: jest.fn(),
  getVoiceProfile: jest.fn(),
  getVoiceSample: jest.fn(),
  putVoiceProfile: jest.fn(),
  createReflection: jest.fn(),
  setVoiceSampleMuted: jest.fn(),
}));

const { embedText } = await import("../services/embeddings.mjs");
const { putVoiceSample, deleteVoiceSample } = await import("../services/voice-vectors.mjs");
const { reflectVoiceProfile } = await import("../services/bedrock.mjs");
const { enqueueReflectionCatchup } = await import("../services/reflection-queue.mjs");
const { NotFoundError } = await import("../services/errors.mjs");
const {
  claimReflectionSlot, countSampleOnce, createVoiceSample, deleteVoiceSampleRow, listRecentSamples,
  getVoiceProfile, getVoiceSample, putVoiceProfile, createReflection, setVoiceSampleMuted,
} = await import("../domain/voice.mjs");
const {
  recordVoiceSample, runReflection, maybeReflect,
  captureContentVoiceSample, removeContentVoiceSample,
  buildContentSampleText, contentVoiceSampleId, isVoiceEligibleContent,
  reflectAfterCuration, removeSampleAndSync, setSampleMutedAndSync,
} = await import("../services/voice-memory.mjs");

const sample = {
  tenantId: "T1", platform: "x", sampleId: "S1", format: "social",
  text: "hello world", publishedAt: "2026-07-01",
};

beforeEach(() => {
  jest.clearAllMocks();
  embedText.mockResolvedValue([0.1, 0.2]);
  putVoiceSample.mockResolvedValue();
  deleteVoiceSample.mockResolvedValue();
  countSampleOnce.mockResolvedValue({ counted: true, count: 1 });
  createVoiceSample.mockResolvedValue({});
  deleteVoiceSampleRow.mockResolvedValue();
  listRecentSamples.mockResolvedValue([
    { text: "a", publishedAt: "2026-07-01" },
    { text: "b", publishedAt: "2025-01-01" },
  ]);
  getVoiceProfile.mockResolvedValue(null);
  getVoiceSample.mockResolvedValue(null);
  claimReflectionSlot.mockResolvedValue(true);
  enqueueReflectionCatchup.mockResolvedValue({ enqueued: true });
  reflectVoiceProfile.mockResolvedValue({ profile: { tone: "wry", portrait: "You write plainly." }, change_summary: "built it" });
  putVoiceProfile.mockResolvedValue({});
  createReflection.mockResolvedValue({});
});

describe("recordVoiceSample", () => {
  test("embeds, upserts (with publishedAt), and counts — no reflection below threshold", async () => {
    countSampleOnce.mockResolvedValue({ counted: true, count: 2 });
    const res = await recordVoiceSample(sample);
    expect(res).toEqual({ count: 2 });
    expect(embedText).toHaveBeenCalledWith("hello world");
    expect(putVoiceSample).toHaveBeenCalledWith(expect.objectContaining({
      sampleId: "S1", publishedAt: "2026-07-01",
    }));
    expect(countSampleOnce).toHaveBeenCalledWith("T1", "x", "S1");
    expect(reflectVoiceProfile).not.toHaveBeenCalled();
  });

  test("anchors undated samples on their capture time so compose recency still sees them", async () => {
    await recordVoiceSample({
      tenantId: "T1", platform: "x", sampleId: "S2", format: "social",
      text: "hi", createdAt: "2026-07-12T09:00:00.000Z",
    });
    expect(putVoiceSample).toHaveBeenCalledWith(expect.objectContaining({
      sampleId: "S2", publishedAt: "2026-07-12T09:00:00.000Z",
    }));
  });

  test("keeps generated drafts out of the vector path and the reflection cadence", async () => {
    const res = await recordVoiceSample({ ...sample, source: "generated" });
    expect(res).toEqual({ skipped: true, reason: "generated" });
    expect(embedText).not.toHaveBeenCalled();
    expect(putVoiceSample).not.toHaveBeenCalled();
    expect(countSampleOnce).not.toHaveBeenCalled();
  });

  test("triggers a coalesced reflection once the counter reaches the threshold", async () => {
    countSampleOnce.mockResolvedValue({ counted: true, count: 3 });
    await recordVoiceSample(sample);
    expect(claimReflectionSlot).toHaveBeenCalledWith("T1", "x", expect.objectContaining({ threshold: 3 }));
    expect(reflectVoiceProfile).toHaveBeenCalledTimes(1);
    expect(putVoiceProfile).toHaveBeenCalledWith("T1", "x", expect.objectContaining({ version: 1 }));
    expect(createReflection).toHaveBeenCalledTimes(1);
  });

  test("coalesces: when the reflection slot is taken, it skips Bedrock entirely", async () => {
    countSampleOnce.mockResolvedValue({ counted: true, count: 9 });
    claimReflectionSlot.mockResolvedValue(false); // another reflection ran recently / in flight
    const res = await recordVoiceSample(sample);
    expect(res).toEqual({ count: 9 });
    expect(reflectVoiceProfile).not.toHaveBeenCalled();
    expect(enqueueReflectionCatchup).not.toHaveBeenCalled();
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
  test("bumps version off the prior profile and records the reflection with the half-life + snapshot", async () => {
    getVoiceProfile.mockResolvedValue({ profile: { tone: "old" }, version: 4, createdAt: "t0", steering: "be concise" });
    await runReflection("T1", "x");
    expect(reflectVoiceProfile).toHaveBeenCalledWith(expect.objectContaining({
      platform: "x", currentProfile: { tone: "old" }, steering: "be concise",
    }));
    expect(putVoiceProfile).toHaveBeenCalledWith("T1", "x", {
      profile: { tone: "wry", portrait: "You write plainly." }, version: 5, createdAt: "t0", steering: "be concise",
    });
    expect(createReflection).toHaveBeenCalledWith("T1", "x", expect.objectContaining({
      sampleWindow: 2, halfLifeDays: 90, version: 5, portrait: "You write plainly.",
    }));
  });

  test("excludes muted and generated samples from the learned voice", async () => {
    listRecentSamples.mockResolvedValue([
      { text: "authored", publishedAt: "2026-07-01", source: "content-auto" },
      { text: "muted one", publishedAt: "2026-07-02", muted: true, source: "manual" },
      { text: "ai draft", publishedAt: "2026-07-03", source: "generated" },
    ]);
    await runReflection("T1", "x");
    const { samples } = reflectVoiceProfile.mock.calls[0][0];
    expect(samples.map((s) => s.text)).toEqual(["authored"]);
  });

  test("returns the existing (empty) profile when nothing eligible and no learned profile", async () => {
    listRecentSamples.mockResolvedValue([
      { text: "ai", source: "generated" },
      { text: "muted", muted: true, source: "manual" },
    ]);
    getVoiceProfile.mockResolvedValue(null);
    expect(await runReflection("T1", "x")).toBeNull();
    expect(reflectVoiceProfile).not.toHaveBeenCalled();
    expect(putVoiceProfile).not.toHaveBeenCalled();
  });

  test("CLEARS a learned profile when the last eligible sample is removed", async () => {
    // Only muted/generated remain, but a real profile exists — it must be
    // cleared so stale traits stop driving compose.
    listRecentSamples.mockResolvedValue([{ text: "muted", muted: true, source: "content-auto" }]);
    getVoiceProfile.mockResolvedValue({ profile: { tone: "wry" }, version: 4, createdAt: "t0", steering: "be bold" });
    const cleared = { profile: null, version: 5 };
    putVoiceProfile.mockResolvedValue(cleared);

    const res = await runReflection("T1", "x");
    expect(reflectVoiceProfile).not.toHaveBeenCalled(); // no Bedrock — nothing to learn
    expect(putVoiceProfile).toHaveBeenCalledWith("T1", "x", {
      profile: null, version: 5, createdAt: "t0", steering: "be bold",
    });
    expect(createReflection).toHaveBeenCalledWith("T1", "x", expect.objectContaining({
      sampleWindow: 0, version: 5, portrait: null,
    }));
    expect(res).toBe(cleared);
  });

  test("does not re-clear an already-empty profile (idempotent)", async () => {
    listRecentSamples.mockResolvedValue([{ text: "muted", muted: true }]);
    getVoiceProfile.mockResolvedValue({ profile: null, version: 5, createdAt: "t0" });
    const res = await runReflection("T1", "x");
    expect(putVoiceProfile).not.toHaveBeenCalled();
    expect(createReflection).not.toHaveBeenCalled();
    expect(res).toEqual({ profile: null, version: 5, createdAt: "t0" });
  });

  test("pulls a wider candidate pool and hands the model recency-weighted samples, newest first", async () => {
    listRecentSamples.mockResolvedValue([
      { text: "old", publishedAt: "2020-01-01" },
      { text: "new", publishedAt: "2026-07-01" },
    ]);
    await runReflection("T1", "x");
    // Pool is wider than the reflection window so late-captured old posts
    // can't crowd out newer-published ones.
    expect(listRecentSamples).toHaveBeenCalledWith("T1", "x", 30);
    const { samples } = reflectVoiceProfile.mock.calls[0][0];
    expect(samples.map((s) => s.text)).toEqual(["new", "old"]);
    expect(samples[0].weightShare).toBeGreaterThan(samples[1].weightShare);
    const total = samples.reduce((acc, s) => acc + s.weightShare, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  test("returns null and skips Bedrock when there are no samples", async () => {
    listRecentSamples.mockResolvedValue([]);
    expect(await runReflection("T1", "x")).toBeNull();
    expect(reflectVoiceProfile).not.toHaveBeenCalled();
  });
});

describe("maybeReflect (coalescing)", () => {
  test("on a won claim, enqueues the trailing catch-up BEFORE reflecting", async () => {
    const order = [];
    enqueueReflectionCatchup.mockImplementation(async () => { order.push("enqueue"); return {}; });
    reflectVoiceProfile.mockImplementation(async () => { order.push("reflect"); return { profile: {}, change_summary: "s" }; });
    const res = await maybeReflect("T1", "x");
    expect(res.reflected).toBe(true);
    expect(order).toEqual(["enqueue", "reflect"]); // catch-up guaranteed even if reflect then throttles
  });

  test("on a lost claim, does not enqueue or reflect", async () => {
    claimReflectionSlot.mockResolvedValue(false);
    const res = await maybeReflect("T1", "x");
    expect(res).toEqual({ reflected: false, reason: "coalesced" });
    expect(enqueueReflectionCatchup).not.toHaveBeenCalled();
    expect(reflectVoiceProfile).not.toHaveBeenCalled();
  });

  test("a reflection failure is swallowed (the catch-up will retry)", async () => {
    reflectVoiceProfile.mockRejectedValue(new Error("bedrock throttled"));
    const res = await maybeReflect("T1", "x");
    expect(res).toEqual({ reflected: false, reason: "error" });
    expect(enqueueReflectionCatchup).toHaveBeenCalledTimes(1); // enqueued before the failure
  });

  test("a catch-up enqueue failure does not block the reflection", async () => {
    enqueueReflectionCatchup.mockRejectedValue(new Error("sqs down"));
    const res = await maybeReflect("T1", "x");
    expect(res.reflected).toBe(true);
    expect(reflectVoiceProfile).toHaveBeenCalledTimes(1);
  });
});

describe("content auto-capture", () => {
  const content = {
    tenantId: "T1",
    contentId: "C1",
    entity: "Content",
    type: "blog",
    status: "published",
    title: "My Post",
    description: "About things",
    contentMarkdown: "# Heading\n\nBody text.",
    publishDate: "2026-07-10",
    createdAt: "2026-07-11T00:00:00.000Z",
  };

  test("captures a published blog as a deterministic, publish-anchored sample", async () => {
    const res = await captureContentVoiceSample(content);
    expect(res).toEqual({ sampleId: "CONTENT-C1" });
    expect(createVoiceSample).toHaveBeenCalledWith("T1", {
      text: buildContentSampleText(content),
      platform: "blog",
      format: "blog",
      source: "content-auto",
      sampleId: "CONTENT-C1",
      publishedAt: "2026-07-10",
    });
  });

  test("falls back to createdAt when the content has no publishDate", async () => {
    await captureContentVoiceSample({ ...content, publishDate: undefined });
    expect(createVoiceSample).toHaveBeenCalledWith("T1", expect.objectContaining({
      publishedAt: "2026-07-11T00:00:00.000Z",
    }));
  });

  test("does not re-capture a muted sample — muting a post is durable across edits", async () => {
    getVoiceSample.mockResolvedValue({ sampleId: "CONTENT-C1", muted: true });
    const res = await captureContentVoiceSample(content);
    expect(res).toEqual({ skipped: true, reason: "muted" });
    expect(createVoiceSample).not.toHaveBeenCalled();
  });

  test("re-captures a previously-captured but un-muted sample", async () => {
    getVoiceSample.mockResolvedValue({ sampleId: "CONTENT-C1" });
    await captureContentVoiceSample(content);
    expect(createVoiceSample).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["draft", { ...content, status: "draft" }],
    ["non-blog", { ...content, type: "video" }],
    ["empty text", { ...content, title: undefined, description: undefined, contentMarkdown: "  " }],
  ])("skips %s content", async (_label, item) => {
    const res = await captureContentVoiceSample(item);
    expect(res).toEqual({ skipped: true, reason: "not-eligible" });
    expect(createVoiceSample).not.toHaveBeenCalled();
  });

  test("sample text is title + description + a bounded excerpt", () => {
    const long = { ...content, contentMarkdown: "x".repeat(10_000) };
    const text = buildContentSampleText(long);
    expect(text.startsWith("My Post\n\nAbout things\n\n")).toBe(true);
    expect(text.length).toBeLessThanOrEqual("My Post\n\nAbout things\n\n".length + 4000);
  });

  test("isVoiceEligibleContent mirrors the capture gate", () => {
    expect(isVoiceEligibleContent(content)).toBe(true);
    expect(isVoiceEligibleContent({ ...content, status: "draft" })).toBe(false);
    expect(isVoiceEligibleContent({ ...content, type: "social" })).toBe(false);
  });

  test("removeContentVoiceSample deletes vector then row", async () => {
    const res = await removeContentVoiceSample(content);
    expect(res).toEqual({ sampleId: "CONTENT-C1" });
    expect(deleteVoiceSample).toHaveBeenCalledWith({ tenantId: "T1", platform: "blog", sampleId: "CONTENT-C1" });
    expect(deleteVoiceSampleRow).toHaveBeenCalledWith("T1", "blog", "CONTENT-C1");
  });

  test("removeContentVoiceSample tolerates a never-captured piece", async () => {
    deleteVoiceSampleRow.mockRejectedValue(new NotFoundError("VoiceSample", "CONTENT-C1"));
    const res = await removeContentVoiceSample(content);
    expect(res).toEqual({ skipped: true, reason: "no-sample" });
  });

  test("contentVoiceSampleId is deterministic", () => {
    expect(contentVoiceSampleId("C1")).toBe("CONTENT-C1");
  });
});

describe("curation sync", () => {
  test("mute drops the vector and skips re-embedding", async () => {
    setVoiceSampleMuted.mockResolvedValue({ sampleId: "S1", platform: "x", text: "a", muted: true });

    const updated = await setSampleMutedAndSync("T1", "x", "S1", true);

    expect(setVoiceSampleMuted).toHaveBeenCalledWith("T1", "x", "S1", true);
    expect(deleteVoiceSample).toHaveBeenCalledWith({ tenantId: "T1", platform: "x", sampleId: "S1" });
    expect(putVoiceSample).not.toHaveBeenCalled();
    expect(updated.muted).toBe(true);
  });

  test("unmute re-embeds from the stored text and re-adds the vector", async () => {
    setVoiceSampleMuted.mockResolvedValue({
      sampleId: "S1", platform: "x", format: "social", text: "hello", publishedAt: "2026-06-01",
    });
    embedText.mockResolvedValue([0.5]);

    await setSampleMutedAndSync("T1", "x", "S1", false);

    expect(embedText).toHaveBeenCalledWith("hello");
    expect(putVoiceSample).toHaveBeenCalledWith(expect.objectContaining({
      sampleId: "S1", embedding: [0.5], publishedAt: "2026-06-01",
    }));
  });

  test("remove deletes the row and the vector", async () => {
    await removeSampleAndSync("T1", "x", "S1");

    expect(deleteVoiceSampleRow).toHaveBeenCalledWith("T1", "x", "S1");
    expect(deleteVoiceSample).toHaveBeenCalledWith({ tenantId: "T1", platform: "x", sampleId: "S1" });
  });

  test("a reflection failure is swallowed so the curation action succeeds", async () => {
    listRecentSamples.mockRejectedValue(new Error("dynamo down"));
    await expect(reflectAfterCuration("T1", "x")).resolves.toBeNull();
  });
});
