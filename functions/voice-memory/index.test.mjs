import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

jest.unstable_mockModule("../../api/services/voice-memory.mjs", () => ({
  recordVoiceSample: jest.fn(),
  captureContentVoiceSample: jest.fn(),
  removeContentVoiceSample: jest.fn(),
  maybeReflect: jest.fn(),
  // The real eligibility gate: published blogs with text feed the voice.
  isVoiceEligibleContent: (c) => c?.type === "blog" && c?.status === "published" && Boolean(c?.title),
}));

const { recordVoiceSample, captureContentVoiceSample, removeContentVoiceSample, maybeReflect } =
  await import("../../api/services/voice-memory.mjs");
const { handler } = await import("./index.mjs");

const sampleImage = {
  pk: "TENANT#T1",
  sk: "VOICE#SAMPLE#x#S1",
  entity: "VoiceSample",
  tenantId: "T1",
  platform: "x",
  sampleId: "S1",
  text: "hello",
};

const contentImage = {
  pk: "TENANT#T1",
  sk: "CONTENT#C1",
  entity: "Content",
  tenantId: "T1",
  contentId: "C1",
  type: "blog",
  status: "published",
  title: "Post",
  contentMarkdown: "body",
  publishDate: "2026-07-10",
};

const record = (eventName, newImage, oldImage) => ({
  eventName,
  dynamodb: {
    ...(newImage ? { NewImage: marshall(newImage) } : {}),
    ...(oldImage ? { OldImage: marshall(oldImage) } : {}),
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  recordVoiceSample.mockResolvedValue({ count: 1 });
  captureContentVoiceSample.mockResolvedValue({ sampleId: "CONTENT-C1" });
  removeContentVoiceSample.mockResolvedValue({ sampleId: "CONTENT-C1" });
  maybeReflect.mockResolvedValue({ reflected: true });
});

describe("VoiceSample records", () => {
  test("INSERT routes to recordVoiceSample with the unmarshalled sample", async () => {
    await handler({ Records: [record("INSERT", sampleImage)] });
    expect(recordVoiceSample).toHaveBeenCalledTimes(1);
    expect(recordVoiceSample.mock.calls[0][0]).toMatchObject({ sampleId: "S1", entity: "VoiceSample" });
  });

  test("MODIFY with changed text re-records (an edit is fresh voice signal)", async () => {
    await handler({ Records: [record("MODIFY", { ...sampleImage, text: "edited" }, sampleImage)] });
    expect(recordVoiceSample).toHaveBeenCalledTimes(1);
    expect(recordVoiceSample.mock.calls[0][0].text).toBe("edited");
  });

  test("MODIFY with unchanged text is skipped (the vectorizedAt stamp must not loop)", async () => {
    await handler({ Records: [record("MODIFY", { ...sampleImage, vectorizedAt: "t1" }, sampleImage)] });
    expect(recordVoiceSample).not.toHaveBeenCalled();
  });

  test("MODIFY that moves the publish anchor re-records so the vector metadata follows", async () => {
    await handler({ Records: [
      record("MODIFY", { ...sampleImage, publishedAt: "2026-07-01" }, sampleImage),
    ] });
    expect(recordVoiceSample).toHaveBeenCalledTimes(1);
  });

  test("processes every sample in a batch", async () => {
    await handler({ Records: [
      record("INSERT", sampleImage),
      record("INSERT", { ...sampleImage, sampleId: "S2", sk: "VOICE#SAMPLE#x#S2" }),
    ] });
    expect(recordVoiceSample).toHaveBeenCalledTimes(2);
  });
});

describe("Content records (blog auto-capture)", () => {
  test("INSERT captures the published blog as a voice sample", async () => {
    await handler({ Records: [record("INSERT", contentImage)] });
    expect(captureContentVoiceSample).toHaveBeenCalledTimes(1);
    expect(captureContentVoiceSample.mock.calls[0][0]).toMatchObject({ contentId: "C1" });
  });

  test("MODIFY that changes voice-relevant fields re-captures", async () => {
    await handler({ Records: [
      record("MODIFY", { ...contentImage, contentMarkdown: "rewritten" }, contentImage),
    ] });
    expect(captureContentVoiceSample).toHaveBeenCalledTimes(1);
  });

  test("MODIFY that only touches links/ids is skipped", async () => {
    await handler({ Records: [
      record("MODIFY", { ...contentImage, links: { dev: "https://dev.to/x" } }, contentImage),
    ] });
    expect(captureContentVoiceSample).not.toHaveBeenCalled();
    expect(removeContentVoiceSample).not.toHaveBeenCalled();
  });

  test("unpublishing removes the derived sample", async () => {
    captureContentVoiceSample.mockResolvedValue({ skipped: true, reason: "not-eligible" });
    await handler({ Records: [
      record("MODIFY", { ...contentImage, status: "draft" }, contentImage),
    ] });
    expect(removeContentVoiceSample).toHaveBeenCalledTimes(1);
  });

  test("retyping a published blog away from blog removes the derived sample", async () => {
    captureContentVoiceSample.mockResolvedValue({ skipped: true, reason: "not-eligible" });
    await handler({ Records: [
      record("MODIFY", { ...contentImage, type: "video" }, contentImage),
    ] });
    expect(removeContentVoiceSample).toHaveBeenCalledTimes(1);
  });

  test("a skipped capture on never-eligible content does not attempt removal", async () => {
    captureContentVoiceSample.mockResolvedValue({ skipped: true, reason: "not-eligible" });
    await handler({ Records: [
      record("MODIFY", { ...contentImage, status: "draft", title: "renamed" }, { ...contentImage, status: "draft" }),
    ] });
    expect(removeContentVoiceSample).not.toHaveBeenCalled();
  });

  test("REMOVE deletes the content's voice sample", async () => {
    await handler({ Records: [record("REMOVE", undefined, contentImage)] });
    expect(removeContentVoiceSample).toHaveBeenCalledTimes(1);
    expect(removeContentVoiceSample.mock.calls[0][0]).toMatchObject({ contentId: "C1" });
    expect(recordVoiceSample).not.toHaveBeenCalled();
  });
});

test("ignores unexpected entities (defense behind the stream filter)", async () => {
  await handler({ Records: [record("INSERT", { ...sampleImage, entity: "Blog" })] });
  expect(recordVoiceSample).not.toHaveBeenCalled();
  expect(captureContentVoiceSample).not.toHaveBeenCalled();
});

describe("SQS reflection catch-ups", () => {
  const sqsRecord = (body) => ({ eventSource: "aws:sqs", body: typeof body === "string" ? body : JSON.stringify(body) });

  test("routes a catch-up to a coalesced reflection", async () => {
    await handler({ Records: [sqsRecord({ type: "reflection-catchup", tenantId: "T1", platform: "blog" })] });
    expect(maybeReflect).toHaveBeenCalledWith("T1", "blog");
    expect(recordVoiceSample).not.toHaveBeenCalled();
  });

  test("ignores an unparseable or incomplete catch-up", async () => {
    await handler({ Records: [sqsRecord("not json"), sqsRecord({ tenantId: "T1" })] });
    expect(maybeReflect).not.toHaveBeenCalled();
  });

  test("a mixed batch dispatches each record by its event source", async () => {
    await handler({ Records: [
      record("INSERT", sampleImage),
      sqsRecord({ tenantId: "T1", platform: "x" }),
    ] });
    expect(recordVoiceSample).toHaveBeenCalledTimes(1);
    expect(maybeReflect).toHaveBeenCalledWith("T1", "x");
  });
});
