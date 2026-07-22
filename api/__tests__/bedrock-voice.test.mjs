import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

// The structured voice functions (compose/reflect/assess) run on the shared
// @readysetcloud/agent runtime; mock runAgent so the suite verifies how they
// invoke it (prompt, input, schema, sampling config) without loading
// Strands/Bedrock. The streaming path still uses the raw SDK, mocked via
// BedrockRuntimeClient.prototype.send.
jest.unstable_mockModule("@readysetcloud/agent", () => ({ runAgent: jest.fn() }));

const { runAgent } = await import("@readysetcloud/agent");
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

const okRun = (output) => ({ output, text: JSON.stringify(output), structured: true, stopReason: "endTurn", invocationState: {} });

describe("services/bedrock voice", () => {
  beforeEach(() => jest.clearAllMocks());

  test("composeVoicePost forces the post schema, threads profile + examples, blog gets more tokens", async () => {
    runAgent.mockResolvedValueOnce(okRun({ post: "Drafted.", title: "T" }));

    const result = await composeVoicePost({
      topic: "ship faster",
      platform: "blog",
      format: "blog",
      profile: { tone: "wry" },
      samples: [{ text: "past post one" }],
      guidance: "mention CI",
    });

    expect(result.post).toBe("Drafted.");
    const call = runAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("structured result");
    expect(call.temperature).toBe(0.6);
    expect(call.maxTokens).toBe(3072);
    expect(call.maxIterations).toBe(1);

    // The zod schema requires the post; the title is optional (social posts).
    expect(call.outputSchema.safeParse({ post: "p", title: "t" }).success).toBe(true);
    expect(call.outputSchema.safeParse({ post: "p" }).success).toBe(true);
    expect(call.outputSchema.safeParse({ title: "t" }).success).toBe(false);

    const userText = call.input;
    expect(userText).toContain("STYLE PROFILE (blog)");
    expect(userText).toContain('"tone": "wry"');
    expect(userText).toContain("[1] past post one");
    expect(userText).toContain("ship faster");
    expect(userText).toContain("mention CI");
  });

  test("composeVoicePost annotates examples with their publish date", async () => {
    runAgent.mockResolvedValueOnce(okRun({ post: "p" }));
    await composeVoicePost({
      topic: "t", platform: "x", format: "social", profile: null,
      samples: [{ text: "dated post", publishedAt: "2026-07-01T08:00:00Z" }, { text: "undated post" }],
    });
    const userText = runAgent.mock.calls[0][0].input;
    expect(userText).toContain("[1] (published 2026-07-01) dated post");
    expect(userText).toContain("[2] undated post");
  });

  test("composeVoicePost caps social drafts at 512 tokens", async () => {
    runAgent.mockResolvedValueOnce(okRun({ post: "short" }));
    await composeVoicePost({ topic: "t", platform: "x", format: "social", profile: null, samples: [] });
    expect(runAgent.mock.calls[0][0].maxTokens).toBe(512);
  });

  test("reflectVoiceProfile forces the profile schema and feeds recent samples", async () => {
    runAgent.mockResolvedValueOnce(okRun({
      profile: { tone: "earnest" }, change_summary: "tightened tone",
    }));

    const result = await reflectVoiceProfile({
      platform: "linkedin",
      currentProfile: { tone: "old" },
      samples: [{ text: "recent post" }],
    });

    expect(result.profile.tone).toBe("earnest");
    expect(result.change_summary).toBe("tightened tone");
    const call = runAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("structured result");
    expect(call.temperature).toBe(0.3);
    expect(call.maxTokens).toBe(2048);
    const userText = call.input;
    expect(userText).toContain("CURRENT PROFILE (linkedin)");
    expect(userText).toContain("recent post");
  });

  test("reflectVoiceProfile states each sample's publish date and recency weight share", async () => {
    runAgent.mockResolvedValueOnce(okRun({ profile: {}, change_summary: "s" }));
    await reflectVoiceProfile({
      platform: "blog",
      currentProfile: null,
      samples: [
        { text: "newest", publishedAt: "2026-07-10", weightShare: 0.6 },
        { text: "older", publishedAt: "2025-11-02", weightShare: 0.4 },
      ],
    });
    const userText = runAgent.mock.calls[0][0].input;
    expect(userText).toContain("[1] (published 2026-07-10, recency weight 60%) newest");
    expect(userText).toContain("[2] (published 2025-11-02, recency weight 40%) older");
    expect(userText).toContain("newest-published first");
  });

  test("reflectVoiceProfile asks the model for a plain-English portrait", async () => {
    runAgent.mockResolvedValueOnce(okRun({ profile: {}, change_summary: "s" }));
    await reflectVoiceProfile({ platform: "blog", currentProfile: null, samples: [{ text: "post" }] });
    const call = runAgent.mock.calls[0][0];
    // The reflect prompt drives the human-readable portrait...
    expect(call.systemPrompt).toContain("portrait");
    // ...and the forced schema has a place to put it: a profile with a
    // portrait validates, the profile + change_summary pair is required.
    expect(call.outputSchema.safeParse({
      profile: { portrait: "You write plainly.", tone: "wry" },
      change_summary: "s",
    }).success).toBe(true);
    expect(call.outputSchema.safeParse({ profile: {} }).success).toBe(false);
    expect(call.outputSchema.safeParse({
      profile: { portrait: 42 },
      change_summary: "s",
    }).success).toBe(false);
  });

  test("reflectVoiceProfile injects the steering note when present", async () => {
    runAgent.mockResolvedValueOnce(okRun({ profile: {}, change_summary: "s" }));
    await reflectVoiceProfile({ platform: "blog", currentProfile: null, samples: [{ text: "post" }], steering: "be more concise" });
    const userText = runAgent.mock.calls[0][0].input;
    expect(userText).toContain("STEERING THEIR VOICE");
    expect(userText).toContain("be more concise");
  });

  test("reflectVoiceProfile omits the steering block when there's no note", async () => {
    runAgent.mockResolvedValueOnce(okRun({ profile: {}, change_summary: "s" }));
    await reflectVoiceProfile({ platform: "blog", currentProfile: null, samples: [{ text: "post" }], steering: null });
    expect(runAgent.mock.calls[0][0].input).not.toContain("STEERING");
  });

  test("assessVoiceMatch forces the assessment schema and grounds on profile + dated draft", async () => {
    runAgent.mockResolvedValueOnce(okRun({
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
    const call = runAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("structured result");
    expect(call.temperature).toBe(0.2);
    expect(call.maxTokens).toBe(1536);

    // The zod schema bounds the score, closes the verdict enum, and requires
    // detail + suggestion on every issue.
    expect(call.outputSchema.safeParse({
      score: 90, verdict: "on_voice", summary: "s",
      issues: [{ detail: "d", suggestion: "fix" }],
    }).success).toBe(true);
    expect(call.outputSchema.safeParse({ score: 130, verdict: "on_voice", summary: "s" }).success).toBe(false);
    expect(call.outputSchema.safeParse({ score: 50, verdict: "meh", summary: "s" }).success).toBe(false);
    expect(call.outputSchema.safeParse({
      score: 50, verdict: "close", summary: "s", issues: [{ detail: "d" }],
    }).success).toBe(false);

    const userText = call.input;
    expect(userText).toContain("STYLE PROFILE (x)");
    expect(userText).toContain('"tone": "wry"');
    expect(userText).toContain("[1] (published 2026-07-01) a real past post");
    expect(userText).toContain("DRAFT TO ASSESS");
    expect(userText).toContain("the draft to grade");
  });

  test("assessVoiceMatch works on a cold start (no profile / no examples)", async () => {
    runAgent.mockResolvedValueOnce(okRun({ score: 30, verdict: "off_voice", summary: "s" }));
    await assessVoiceMatch({ platform: "x", profile: null, samples: [], draft: "d" });
    const userText = runAgent.mock.calls[0][0].input;
    expect(userText).toContain("no learned profile yet");
    expect(userText).toContain("(no examples yet)");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    runAgent.mockRejectedValueOnce(new Error("throttled"));
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
