import { jest } from "@jest/globals";

process.env.EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";
process.env.BEDROCK_REGION = "us-east-1";

const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
const { embedText, EMBEDDING_DIMENSIONS } = await import("../services/embeddings.mjs");
const { UpstreamError } = await import("../services/errors.mjs");

// Builds a Titan InvokeModel response: body is a Uint8Array of JSON.
const titanResponse = (embedding) => ({
  body: new TextEncoder().encode(JSON.stringify({ embedding })),
});

describe("services/embeddings embedText", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  test("rejects empty text without calling Bedrock", async () => {
    await expect(embedText("  ")).rejects.toThrow(/non-empty/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("sends the Titan request body and returns the embedding", async () => {
    const vec = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);
    mockSend.mockResolvedValueOnce(titanResponse(vec));

    const result = await embedText("hello world");
    expect(result).toEqual(vec);

    const command = mockSend.mock.calls[0][0];
    expect(command.input.modelId).toBe("amazon.titan-embed-text-v2:0");
    const body = JSON.parse(command.input.body);
    expect(body.inputText).toBe("hello world");
    expect(body.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(body.normalize).toBe(true);
  });

  test("honors a custom dimension", async () => {
    mockSend.mockResolvedValueOnce(titanResponse([0.1, 0.2]));
    await embedText("hi", { dimensions: 256 });
    const body = JSON.parse(mockSend.mock.calls[0][0].input.body);
    expect(body.dimensions).toBe(256);
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(embedText("hi")).rejects.toThrow(UpstreamError);
  });

  test("throws UpstreamError when the response has no embedding", async () => {
    mockSend.mockResolvedValueOnce({ body: new TextEncoder().encode(JSON.stringify({})) });
    await expect(embedText("hi")).rejects.toThrow(UpstreamError);
  });
});
