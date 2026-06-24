import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

jest.unstable_mockModule("../../api/services/voice-memory.mjs", () => ({
  recordVoiceSample: jest.fn(),
}));

const { recordVoiceSample } = await import("../../api/services/voice-memory.mjs");
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

const record = (eventName, image) => ({ eventName, dynamodb: { NewImage: marshall(image) } });

beforeEach(() => {
  jest.clearAllMocks();
  recordVoiceSample.mockResolvedValue({ count: 1 });
});

test("INSERT routes to recordVoiceSample with the unmarshalled sample", async () => {
  await handler({ Records: [record("INSERT", sampleImage)] });
  expect(recordVoiceSample).toHaveBeenCalledTimes(1);
  expect(recordVoiceSample.mock.calls[0][0]).toMatchObject({ sampleId: "S1", entity: "VoiceSample" });
});

test("ignores non-INSERT events (samples are immutable)", async () => {
  await handler({ Records: [{ ...record("MODIFY", sampleImage) }] });
  expect(recordVoiceSample).not.toHaveBeenCalled();
});

test("ignores a non-VoiceSample image (defense behind the stream filter)", async () => {
  await handler({ Records: [record("INSERT", { ...sampleImage, entity: "Blog" })] });
  expect(recordVoiceSample).not.toHaveBeenCalled();
});

test("processes every sample in a batch", async () => {
  await handler({ Records: [
    record("INSERT", sampleImage),
    record("INSERT", { ...sampleImage, sampleId: "S2", sk: "VOICE#SAMPLE#x#S2" }),
  ] });
  expect(recordVoiceSample).toHaveBeenCalledTimes(2);
});
