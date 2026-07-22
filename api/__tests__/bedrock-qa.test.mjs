import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
const { answerBlogQuestion, answerContentQuestion, streamBlogAnswer } = await import("../services/bedrock/qa.mjs");
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

describe("services/bedrock answerBlogQuestion", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  const answerResponse = (input) => ({
    stopReason: "tool_use",
    output: {
      message: {
        role: "assistant",
        content: [{ toolUse: { name: "record_blog_answer", input } }],
      },
    },
    usage: { inputTokens: 150, outputTokens: 60 },
  });

  test("forces the record_blog_answer tool and numbers the source excerpts", async () => {
    mockSend.mockResolvedValueOnce(answerResponse({
      answer: "You covered build caching.",
      sources_used: [2],
      confidence: "high",
    }));

    const result = await answerBlogQuestion({
      question: "What have I written about caching?",
      chunks: [
        { blogId: "B1", title: "Faster Builds", text: "cut build time" },
        { blogId: "B2", title: "Caching Layers", text: "cache between layers" },
      ],
    });

    expect(result.answer).toBe("You covered build caching.");
    expect(result.sources_used).toEqual([2]);

    const command = mockSend.mock.calls[0][0];
    expect(command.input.toolConfig.toolChoice.tool.name).toBe("record_blog_answer");
    expect(command.input.system).toEqual(
      expect.arrayContaining([expect.objectContaining({ cachePoint: { type: "default" } })]),
    );

    const userText = command.input.messages[0].content[0].text;
    expect(userText).toContain("What have I written about caching?");
    // Excerpts are numbered 1-based with their titles and bodies.
    expect(userText).toContain('[1] "Faster Builds"');
    expect(userText).toContain("[2] \"Caching Layers\"");
    expect(userText).toContain("cache between layers");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(
      answerBlogQuestion({ question: "q", chunks: [{ blogId: "B1", title: "T", text: "x" }] }),
    ).rejects.toThrow(UpstreamError);
  });
});

describe("services/bedrock answerContentQuestion", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  const answerResponse = (input) => ({
    stopReason: "tool_use",
    output: {
      message: {
        role: "assistant",
        content: [{ toolUse: { name: "record_content_answer", input } }],
      },
    },
    usage: { inputTokens: 150, outputTokens: 60 },
  });

  test("forces the record_content_answer tool and numbers the source excerpts", async () => {
    mockSend.mockResolvedValueOnce(answerResponse({
      answer: "You covered build caching.",
      sources_used: [2],
      confidence: "high",
    }));

    const result = await answerContentQuestion({
      question: "What have I written about caching?",
      chunks: [
        { contentId: "C1", title: "Faster Builds", text: "cut build time" },
        { contentId: "C2", title: "Caching Layers", text: "cache between layers" },
      ],
    });

    expect(result.answer).toBe("You covered build caching.");
    expect(result.sources_used).toEqual([2]);

    const command = mockSend.mock.calls[0][0];
    expect(command.input.toolConfig.toolChoice.tool.name).toBe("record_content_answer");
    expect(command.input.system).toEqual(
      expect.arrayContaining([expect.objectContaining({ cachePoint: { type: "default" } })]),
    );

    const userText = command.input.messages[0].content[0].text;
    expect(userText).toContain("What have I written about caching?");
    // Excerpts are numbered 1-based with their titles and bodies.
    expect(userText).toContain('[1] "Faster Builds"');
    expect(userText).toContain("[2] \"Caching Layers\"");
    expect(userText).toContain("cache between layers");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(
      answerContentQuestion({ question: "q", chunks: [{ contentId: "C1", title: "T", text: "x" }] }),
    ).rejects.toThrow(UpstreamError);
  });
});

describe("services/bedrock streamBlogAnswer", () => {
  let mockSend;
  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
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
