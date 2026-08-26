import { jest } from "@jest/globals";

// Mock the rsc-core agent runtime so the suite verifies how each lens invokes
// runAgent (prompt, schema, trusted context) without loading Strands/Bedrock.
jest.unstable_mockModule("@readysetcloud/agent", () => ({ runAgent: jest.fn(), httpRequest: { name: "http_request" } }));

const { runAgent } = await import("@readysetcloud/agent");
const { httpRequest } = await import("@readysetcloud/agent");
const {
  runReadabilityLens,
  runLlmLens,
  runBrandLens,
  runFactLens,
  runSummaryLens,
  runVoiceGuard,
  runLensSafely,
} = await import("../services/review-lenses.mjs");

const TENANT = "user-1";
const BODY = "In today's fast-paced world we leverage synergies to delve into robust solutions.";

const okRun = (suggestions) => ({ output: { suggestions }, text: "", structured: true, stopReason: "endTurn", invocationState: {} });

beforeEach(() => jest.clearAllMocks());

describe("content lenses", () => {
  test("readability lens forces the schema, injects tenantId, and stamps type=grammar", async () => {
    runAgent.mockResolvedValue(okRun([{ textToReplace: "leverage", replaceWith: "use", reason: "simpler", priority: "medium" }]));

    const out = await runReadabilityLens({ body: BODY, tenantId: TENANT });

    expect(out).toEqual([{ textToReplace: "leverage", replaceWith: "use", reason: "simpler", priority: "medium", type: "grammar" }]);
    const call = runAgent.mock.calls[0][0];
    expect(call.input).toBe(BODY);
    expect(call.outputSchema).toBeDefined();
    expect(call.invocationState).toEqual({ tenantId: TENANT });
    expect(call.systemPrompt.toLowerCase()).toContain("readability");
  });

  test("llm lens stamps type=llm", async () => {
    runAgent.mockResolvedValue(okRun([{ textToReplace: "delve into", replaceWith: "explore", reason: "AI tell", priority: "high" }]));
    const out = await runLlmLens({ body: BODY, tenantId: TENANT });
    expect(out[0].type).toBe("llm");
    expect(runAgent.mock.calls[0][0].systemPrompt.toLowerCase()).toContain("ai tell");
  });

  test("returns [] when a lens produces no suggestions", async () => {
    runAgent.mockResolvedValue(okRun([]));
    expect(await runReadabilityLens({ body: BODY, tenantId: TENANT })).toEqual([]);
  });
});

describe("brand lens", () => {
  test("grounds the prompt in the learned profile + samples and stamps type=brand", async () => {
    runAgent.mockResolvedValue(okRun([{ textToReplace: "robust", replaceWith: "solid", reason: "off-voice", priority: "medium" }]));

    const out = await runBrandLens({
      body: BODY,
      tenantId: TENANT,
      platform: "blog",
      profile: { portrait: "You write plainly and skip buzzwords." },
      samples: [{ text: "A real past post.", publishedAt: "2026-06-01T00:00:00Z" }],
    });

    expect(out[0].type).toBe("brand");
    const prompt = runAgent.mock.calls[0][0].systemPrompt;
    expect(prompt).toContain("You write plainly and skip buzzwords.");
    expect(prompt).toContain("A real past post.");
    expect(prompt).toContain("blog");
  });
});

describe("fact lens", () => {
  test("attaches the http_request tool, bounds the loop, and grounds the prompt in the search endpoint", async () => {
    runAgent.mockResolvedValue(okRun([{ textToReplace: '30%', replaceWith: '18%', reason: 'stat is wrong', priority: 'high' }]));

    const out = await runFactLens({
      body: BODY,
      tenantId: TENANT,
      search: { url: 'https://search.example/api', authHeader: { name: 'Authorization', value: 'Bearer k' } },
    });

    expect(out[0].type).toBe('fact');
    const call = runAgent.mock.calls[0][0];
    expect(call.tools).toEqual([httpRequest]);
    expect(call.maxIterations).toBeGreaterThan(0);
    expect(call.systemPrompt).toContain('https://search.example/api');
    expect(call.systemPrompt).toContain('Authorization: Bearer k');
  });
});

describe("summary lens", () => {
  test("returns the verdict + summary and reasons over the findings", async () => {
    runAgent.mockResolvedValue({ output: { verdict: "minor_revisions", summary: "Solid draft, trim the buzzwords." } });

    const out = await runSummaryLens({
      body: BODY,
      tenantId: TENANT,
      findings: [{ type: "llm", reason: "buzzword" }, { type: "grammar", reason: "run-on" }],
    });

    expect(out).toEqual({ verdict: "minor_revisions", summary: "Solid draft, trim the buzzwords." });
    expect(runAgent.mock.calls[0][0].input).toContain("REVIEW FINDINGS (2)");
  });
});

describe("runLensSafely", () => {
  test("passes through success", async () => {
    const res = await runLensSafely("readability", async () => [{ type: "grammar" }]);
    expect(res).toEqual({ name: "readability", suggestions: [{ type: "grammar" }], ok: true });
  });

  test("isolates a lens failure to an empty, ok:false result", async () => {
    const res = await runLensSafely("llm", async () => { throw new Error("bedrock down"); });
    expect(res).toEqual({ name: "llm", suggestions: [], ok: false });
  });
});

// The grounding bundle the runner assembles: the learned profile plus the
// habits measured off the retrieved samples.
const VOICE = {
  platform: "blog",
  profile: {
    portrait: "You write like you are talking to one person over coffee.",
    tone: "wry",
    signature_phrases: ["here's the thing"],
    dos: ["open with a story"],
    donts: ["open with a definition"],
  },
  samples: [{ text: "A real past post.", publishedAt: "2026-06-01T00:00:00Z" }],
  signature: {
    sampleCount: 8,
    wordCount: 9000,
    avgSentenceWords: 19,
    habits: [{ key: "emDash", label: "Em dashes and parenthetical dashes", rate: 4.2, prevalence: 1, postsWith: 8, occurrences: 38 }],
  },
};

describe("voice constraint on the voice-blind lenses", () => {
  test("readability is told what it must not edit away", async () => {
    runAgent.mockResolvedValue(okRun([]));
    await runReadabilityLens({ body: BODY, tenantId: TENANT, voice: VOICE });

    const prompt = runAgent.mock.calls[0][0].systemPrompt;
    expect(prompt).toContain("You write like you are talking to one person over coffee.");
    expect(prompt).toContain("here's the thing");
    expect(prompt).toContain("Em dashes and parenthetical dashes");
    expect(prompt).toContain("present in 8 of 8 posts");
    expect(prompt).toContain("Treat every trait above as deliberate");
  });

  test("the AI-tell lens is told to check candidates against the author's habits first", async () => {
    runAgent.mockResolvedValue(okRun([]));
    await runLlmLens({ body: BODY, tenantId: TENANT, voice: VOICE });

    const prompt = runAgent.mock.calls[0][0].systemPrompt;
    expect(prompt).toContain("a trait that runs through their published writing is their voice");
    expect(prompt).toContain("Em dashes and parenthetical dashes");
  });

  test("runs unchanged when the tenant has no voice yet", async () => {
    runAgent.mockResolvedValue(okRun([]));
    await runReadabilityLens({ body: BODY, tenantId: TENANT });
    expect(runAgent.mock.calls[0][0].systemPrompt).not.toContain("ESTABLISHED VOICE");
    expect(runAgent.mock.calls[0][0].systemPrompt).not.toContain("MEASURED HABITS");
  });

  test("falls back to the profile alone when the corpus is too small to measure", async () => {
    runAgent.mockResolvedValue(okRun([]));
    await runReadabilityLens({ body: BODY, tenantId: TENANT, voice: { ...VOICE, signature: null } });

    const prompt = runAgent.mock.calls[0][0].systemPrompt;
    expect(prompt).toContain("ESTABLISHED VOICE");
    expect(prompt).not.toContain("MEASURED HABITS");
  });
});

describe("voice guard", () => {
  const CANDIDATES = [
    { type: "grammar", textToReplace: "here's the thing", replaceWith: "notably", reason: "more formal", priority: "low" },
    { type: "llm", textToReplace: "recieve", replaceWith: "receive", reason: "typo", priority: "high" },
  ];

  test("grounds the arbitration in the voice and returns the vetoed positions", async () => {
    runAgent.mockResolvedValue({ output: { drop: [{ index: 1, reason: "that phrase is theirs" }] } });

    const dropped = await runVoiceGuard({ body: BODY, tenantId: TENANT, candidates: CANDIDATES, ...VOICE });

    expect(dropped).toEqual([0]); // 1-based in, 0-based out
    const call = runAgent.mock.calls[0][0];
    expect(call.invocationState).toEqual({ tenantId: TENANT });
    expect(call.systemPrompt).toContain("voice guard");
    expect(call.systemPrompt).toContain("A real past post.");
    expect(call.systemPrompt).toContain("Em dashes and parenthetical dashes");
    expect(call.input).toContain('[1] (grammar) replace "here\'s the thing" with "notably"');
    expect(call.input).toContain("stated reason: more formal");
  });

  test("discards out-of-range and repeated indexes", async () => {
    runAgent.mockResolvedValue({ output: { drop: [{ index: 2, reason: "a" }, { index: 2, reason: "b" }, { index: 9, reason: "c" }, { index: 0, reason: "d" }] } });
    expect(await runVoiceGuard({ body: BODY, tenantId: TENANT, candidates: CANDIDATES, ...VOICE })).toEqual([1]);
  });

  test("keeps everything when the model vetoes nothing", async () => {
    runAgent.mockResolvedValue({ output: { drop: [] } });
    expect(await runVoiceGuard({ body: BODY, tenantId: TENANT, candidates: CANDIDATES, ...VOICE })).toEqual([]);
  });

  test("short-circuits without a model call when there is nothing to judge", async () => {
    expect(await runVoiceGuard({ body: BODY, tenantId: TENANT, candidates: [], ...VOICE })).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
