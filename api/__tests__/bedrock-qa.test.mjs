import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

// The structured Q&A functions run on the shared @readysetcloud/agent runtime;
// mock runAgent so the suite verifies how they invoke it (prompt, input,
// schema, sampling config) without loading Strands/Bedrock. The streaming path
// still uses the raw SDK, mocked via BedrockRuntimeClient.prototype.send.
jest.unstable_mockModule("@readysetcloud/agent", () => ({ runAgent: jest.fn() }));

const { runAgent } = await import("@readysetcloud/agent");
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

const okRun = (output) => ({ output, text: JSON.stringify(output), structured: true, stopReason: "endTurn", invocationState: {} });

describe("services/bedrock answerBlogQuestion", () => {
  beforeEach(() => jest.clearAllMocks());

  test("forces the answer schema via runAgent and numbers the source excerpts", async () => {
    runAgent.mockResolvedValueOnce(okRun({
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

    const call = runAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("structured result");
    expect(call.temperature).toBe(0.2);
    expect(call.maxTokens).toBe(1024);
    expect(call.maxIterations).toBe(1);

    // The zod schema enforces the answer shape: valid answers pass, a bad
    // confidence value or missing field fails.
    expect(call.outputSchema.safeParse({ answer: "a", sources_used: [1], confidence: "low" }).success).toBe(true);
    expect(call.outputSchema.safeParse({ answer: "a", sources_used: [1], confidence: "sky-high" }).success).toBe(false);
    expect(call.outputSchema.safeParse({ answer: "a", sources_used: [0], confidence: "low" }).success).toBe(false);
    expect(call.outputSchema.safeParse({ answer: "a" }).success).toBe(false);

    const userText = call.input;
    expect(userText).toContain("What have I written about caching?");
    // Excerpts are numbered 1-based with their titles and bodies.
    expect(userText).toContain('[1] "Faster Builds"');
    expect(userText).toContain("[2] \"Caching Layers\"");
    expect(userText).toContain("cache between layers");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    runAgent.mockRejectedValueOnce(new Error("throttled"));
    await expect(
      answerBlogQuestion({ question: "q", chunks: [{ blogId: "B1", title: "T", text: "x" }] }),
    ).rejects.toThrow(UpstreamError);
  });
});

describe("services/bedrock answerContentQuestion", () => {
  beforeEach(() => jest.clearAllMocks());

  test("forces the answer schema via runAgent and numbers the source excerpts", async () => {
    runAgent.mockResolvedValueOnce(okRun({
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

    const call = runAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("structured result");
    expect(call.temperature).toBe(0.2);
    expect(call.maxTokens).toBe(1024);
    expect(call.maxIterations).toBe(1);

    expect(call.outputSchema.safeParse({ answer: "a", sources_used: [], confidence: "medium" }).success).toBe(true);
    expect(call.outputSchema.safeParse({ answer: "a", sources_used: ["1"], confidence: "medium" }).success).toBe(false);

    const userText = call.input;
    expect(userText).toContain("What have I written about caching?");
    // Excerpts are numbered 1-based with their titles and bodies.
    expect(userText).toContain('[1] "Faster Builds"');
    expect(userText).toContain("[2] \"Caching Layers\"");
    expect(userText).toContain("cache between layers");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    runAgent.mockRejectedValueOnce(new Error("throttled"));
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
