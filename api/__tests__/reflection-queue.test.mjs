import { jest } from "@jest/globals";

// The queue URL is read at module load, so set it before importing.
process.env.VOICE_REFLECTION_QUEUE_URL = "https://sqs.test/voice-reflection";

const { SQSClient } = await import("@aws-sdk/client-sqs");
const { enqueueReflectionCatchup } = await import("../services/reflection-queue.mjs");

describe("services/reflection-queue", () => {
  let mockSend;
  beforeEach(() => {
    mockSend = jest.fn().mockResolvedValue({});
    SQSClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  test("enqueues a catch-up message with the tenant/platform and a delay", async () => {
    const res = await enqueueReflectionCatchup({ tenantId: "T1", platform: "blog", delaySeconds: 75 });
    expect(res).toEqual({ enqueued: true });
    const input = mockSend.mock.calls[0][0].input;
    expect(input.QueueUrl).toBe("https://sqs.test/voice-reflection");
    expect(input.DelaySeconds).toBe(75);
    expect(JSON.parse(input.MessageBody)).toEqual({ type: "reflection-catchup", tenantId: "T1", platform: "blog" });
  });

  test("clamps the delay to the SQS 15-minute ceiling", async () => {
    await enqueueReflectionCatchup({ tenantId: "T1", platform: "x", delaySeconds: 5000 });
    expect(mockSend.mock.calls[0][0].input.DelaySeconds).toBe(900);
  });

  test("floors a negative delay at 0", async () => {
    await enqueueReflectionCatchup({ tenantId: "T1", platform: "x", delaySeconds: -5 });
    expect(mockSend.mock.calls[0][0].input.DelaySeconds).toBe(0);
  });
});

describe("services/reflection-queue without a configured queue", () => {
  test("is a no-op when VOICE_REFLECTION_QUEUE_URL is unset", async () => {
    jest.resetModules();
    delete process.env.VOICE_REFLECTION_QUEUE_URL;
    const mod = await import("../services/reflection-queue.mjs");
    const { SQSClient: FreshClient } = await import("@aws-sdk/client-sqs");
    const send = jest.fn();
    FreshClient.prototype.send = send;
    const res = await mod.enqueueReflectionCatchup({ tenantId: "T1", platform: "x" });
    expect(res).toEqual({ skipped: true });
    expect(send).not.toHaveBeenCalled();
  });
});
