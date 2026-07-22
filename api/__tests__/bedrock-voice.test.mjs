import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
const { composeVoicePost, reflectVoiceProfile, assessVoiceMatch, streamVoicePost } = await import("../services/bedrock/voice.mjs");
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

describe("services/bedrock voice", () => {
  let mockSend;
  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  const toolResponse = (name, input) => ({
    stopReason: "tool_use",
    output: { message: { role: "assistant", content: [{ toolUse: { name, input } }] } },
    usage: { inputTokens: 100, outputTokens: 40 },
  });

  test("composeVoicePost forces record_voice_post, threads profile + examples, blog gets more tokens", async () => {
    mockSend.mockResolvedValueOnce(toolResponse("record_voice_post", { post: "Drafted.", title: "T" }));

    const result = await composeVoicePost({
      topic: "ship faster",
      platform: "blog",
      format: "blog",
      profile: { tone: "wry" },
      samples: [{ text: "past post one" }],
      guidance: "mention CI",
    });

    expect(result.post).toBe("Drafted.");
    const command = mockSend.mock.calls[0][0];
    expect(command.input.toolConfig.toolChoice.tool.name).toBe("record_voice_post");
    expect(command.input.inferenceConfig.maxTokens).toBe(3072);
    const userText = command.input.messages[0].content[0].text;
    expect(userText).toContain("STYLE PROFILE (blog)");
    expect(userText).toContain('"tone": "wry"');
    expect(userText).toContain("[1] past post one");
    expect(userText).toContain("ship faster");
    expect(userText).toContain("mention CI");
  });

  test("composeVoicePost annotates examples with their publish date", async () => {
    mockSend.mockResolvedValueOnce(toolResponse("record_voice_post", { post: "p" }));
    await composeVoicePost({
      topic: "t", platform: "x", format: "social", profile: null,
      samples: [{ text: "dated post", publishedAt: "2026-07-01T08:00:00Z" }, { text: "undated post" }],
    });
    const userText = mockSend.mock.calls[0][0].input.messages[0].content[0].text;
    expect(userText).toContain("[1] (published 2026-07-01) dated post");
    expect(userText).toContain("[2] undated post");
  });

  test("composeVoicePost caps social drafts at 512 tokens", async () => {
    mockSend.mockResolvedValueOnce(toolResponse("record_voice_post", { post: "short" }));
    await composeVoicePost({ topic: "t", platform: "x", format: "social", profile: null, samples: [] });
    expect(mockSend.mock.calls[0][0].input.inferenceConfig.maxTokens).toBe(512);
  });

  test("reflectVoiceProfile forces record_voice_profile and feeds recent samples", async () => {
    mockSend.mockResolvedValueOnce(toolResponse("record_voice_profile", {
      profile: { tone: "earnest" }, change_summary: "tightened tone",
    }));

    const result = await reflectVoiceProfile({
      platform: "linkedin",
      currentProfile: { tone: "old" },
      samples: [{ text: "recent post" }],
    });

    expect(result.profile.tone).toBe("earnest");
    expect(result.change_summary).toBe("tightened tone");
    const command = mockSend.mock.calls[0][0];
    expect(command.input.toolConfig.toolChoice.tool.name).toBe("record_voice_profile");
    const userText = command.input.messages[0].content[0].text;
    expect(userText).toContain("CURRENT PROFILE (linkedin)");
    expect(userText).toContain("recent post");
  });

  test("reflectVoiceProfile states each sample's publish date and recency weight share", async () => {
    mockSend.mockResolvedValueOnce(toolResponse("record_voice_profile", {
      profile: {}, change_summary: "s",
    }));
    await reflectVoiceProfile({
      platform: "blog",
      currentProfile: null,
      samples: [
        { text: "newest", publishedAt: "2026-07-10", weightShare: 0.6 },
        { text: "older", publishedAt: "2025-11-02", weightShare: 0.4 },
      ],
    });
    const userText = mockSend.mock.calls[0][0].input.messages[0].content[0].text;
    expect(userText).toContain("[1] (published 2026-07-10, recency weight 60%) newest");
    expect(userText).toContain("[2] (published 2025-11-02, recency weight 40%) older");
    expect(userText).toContain("newest-published first");
  });

  test("reflectVoiceProfile asks the model for a plain-English portrait", async () => {
    mockSend.mockResolvedValueOnce(toolResponse("record_voice_profile", { profile: {}, change_summary: "s" }));
    await reflectVoiceProfile({ platform: "blog", currentProfile: null, samples: [{ text: "post" }] });
    const command = mockSend.mock.calls[0][0];
    // The reflect prompt drives the human-readable portrait...
    expect(command.input.system[0].text).toContain("portrait");
    // ...and the forced tool's schema has a place to put it.
    expect(command.input.toolConfig.tools[0].toolSpec.inputSchema.json.properties.profile.properties)
      .toHaveProperty("portrait");
  });

  test("reflectVoiceProfile injects the steering note when present", async () => {
    mockSend.mockResolvedValueOnce(toolResponse("record_voice_profile", { profile: {}, change_summary: "s" }));
    await reflectVoiceProfile({ platform: "blog", currentProfile: null, samples: [{ text: "post" }], steering: "be more concise" });
    const userText = mockSend.mock.calls[0][0].input.messages[0].content[0].text;
    expect(userText).toContain("STEERING THEIR VOICE");
    expect(userText).toContain("be more concise");
  });

  test("reflectVoiceProfile omits the steering block when there's no note", async () => {
    mockSend.mockResolvedValueOnce(toolResponse("record_voice_profile", { profile: {}, change_summary: "s" }));
    await reflectVoiceProfile({ platform: "blog", currentProfile: null, samples: [{ text: "post" }], steering: null });
    expect(mockSend.mock.calls[0][0].input.messages[0].content[0].text).not.toContain("STEERING");
  });

  test("assessVoiceMatch forces record_voice_assessment and grounds on profile + dated draft", async () => {
    mockSend.mockResolvedValueOnce(toolResponse("record_voice_assessment", {
      score: 73, verdict: "close", summary: "Close, but a touch formal.",
      strengths: ["good hook"], issues: [{ area: "tone", detail: "too stiff", suggestion: "loosen up" }],
    }));

    const result = await assessVoiceMatch({
      platform: "x",
      profile: { tone: "wry" },
      samples: [{ text: "a real past post", publishedAt: "2026-07-01" }],
      draft: "the draft to grade",
    });

    expect(result.score).toBe(73);
    expect(result.verdict).toBe("close");
    const command = mockSend.mock.calls[0][0];
    expect(command.input.toolConfig.toolChoice.tool.name).toBe("record_voice_assessment");
    const userText = command.input.messages[0].content[0].text;
    expect(userText).toContain("STYLE PROFILE (x)");
    expect(userText).toContain('"tone": "wry"');
    expect(userText).toContain("[1] (published 2026-07-01) a real past post");
    expect(userText).toContain("DRAFT TO ASSESS");
    expect(userText).toContain("the draft to grade");
  });

  test("assessVoiceMatch works on a cold start (no profile / no examples)", async () => {
    mockSend.mockResolvedValueOnce(toolResponse("record_voice_assessment", { score: 30, verdict: "off_voice", summary: "s" }));
    await assessVoiceMatch({ platform: "x", profile: null, samples: [], draft: "d" });
    const userText = mockSend.mock.calls[0][0].input.messages[0].content[0].text;
    expect(userText).toContain("no learned profile yet");
    expect(userText).toContain("(no examples yet)");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(
      composeVoicePost({ topic: "t", platform: "x", format: "social", profile: null, samples: [] }),
    ).rejects.toThrow(UpstreamError);
  });
});

describe("services/bedrock streamVoicePost", () => {
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

  test("streamVoicePost annotates examples with their publish date when known", async () => {
    mockSend.mockResolvedValueOnce(fakeStream(["x"]));
    await collect(streamVoicePost({
      topic: "t", platform: "x", format: "social", profile: null,
      samples: [{ text: "dated", publishedAt: "2026-07-01T08:00:00Z" }, { text: "undated" }],
    }));
    const userText = mockSend.mock.calls[0][0].input.messages[0].content[0].text;
    expect(userText).toContain("[1] (published 2026-07-01) dated");
    expect(userText).toContain("[2] undated");
  });

  test("streamVoicePost gives blog format more token headroom", async () => {
    mockSend.mockResolvedValueOnce(fakeStream(["x"]));
    await collect(streamVoicePost({ topic: "t", platform: "blog", format: "blog", profile: null, samples: [] }));
    expect(mockSend.mock.calls[0][0].input.inferenceConfig.maxTokens).toBe(3072);
  });

  test("wraps a start-of-stream failure in UpstreamError", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(collect(streamVoicePost({ topic: "t", platform: "x", format: "social", profile: null, samples: [] })))
      .rejects.toThrow(UpstreamError);
  });
});
