import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
const { streamVoicePost, streamBlogAnswer } = await import("../services/bedrock-stream.mjs");
const { UpstreamError } = await import("../services/errors.mjs");

// A Converse stream is an async iterable of events; contentBlockDelta carries
// the text tokens. Build one from a list of strings.
function fakeStream(parts) {
  return {
    stream: (async function* () {
      for (const text of parts) yield { contentBlockDelta: { delta: { text } } };
      yield { messageStop: { stopReason: "end_turn" } };
    })(),
  };
}

async function collect(gen) {
  const out = [];
  for await (const t of gen) out.push(t);
  return out;
}

describe("services/bedrock-stream", () => {
  let mockSend;
  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  test("streamVoicePost yields text deltas and threads profile + examples + format", async () => {
    mockSend.mockResolvedValueOnce(fakeStream(["Hello", " world"]));

    const deltas = await collect(streamVoicePost({
      topic: "ship faster",
      platform: "x",
      format: "social",
      profile: { tone: "wry" },
      samples: [{ text: "past post" }],
      guidance: "keep it short",
    }));

    expect(deltas).toEqual(["Hello", " world"]);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.modelId).toBe("us.amazon.nova-pro-v1:0");
    expect(command.input.inferenceConfig.maxTokens).toBe(512);
    const userText = command.input.messages[0].content[0].text;
    expect(userText).toContain("ship faster");
    expect(userText).toContain('"tone": "wry"');
    expect(userText).toContain("[1] past post");
    expect(userText).toContain("keep it short");
  });

  test("streamVoicePost gives blog format more token headroom", async () => {
    mockSend.mockResolvedValueOnce(fakeStream(["x"]));
    await collect(streamVoicePost({ topic: "t", platform: "blog", format: "blog", profile: null, samples: [] }));
    expect(mockSend.mock.calls[0][0].input.inferenceConfig.maxTokens).toBe(3072);
  });

  test("streamBlogAnswer numbers the excerpts and streams the answer", async () => {
    mockSend.mockResolvedValueOnce(fakeStream(["You ", "wrote about caching."]));
    const deltas = await collect(streamBlogAnswer({
      question: "what about caching?",
      chunks: [{ title: "Caching", text: "cache layers" }],
    }));
    expect(deltas.join("")).toBe("You wrote about caching.");
    const userText = mockSend.mock.calls[0][0].input.messages[0].content[0].text;
    expect(userText).toContain("what about caching?");
    expect(userText).toContain('[1] "Caching"');
  });

  test("wraps a start-of-stream failure in UpstreamError", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(collect(streamVoicePost({ topic: "t", platform: "x", format: "social", profile: null, samples: [] })))
      .rejects.toThrow(UpstreamError);
  });

  test("wraps a mid-stream failure in UpstreamError", async () => {
    mockSend.mockResolvedValueOnce({
      stream: (async function* () {
        yield { contentBlockDelta: { delta: { text: "partial" } } };
        throw new Error("connection reset");
      })(),
    });
    const gen = streamBlogAnswer({ question: "q", chunks: [{ title: "T", text: "x" }] });
    await expect(collect(gen)).rejects.toThrow(UpstreamError);
  });
});
