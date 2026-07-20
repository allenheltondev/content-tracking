import { jest } from "@jest/globals";

// Mock the rsc-core agent runtime so the suite verifies how each lens invokes
// runAgent (prompt, schema, trusted context) without loading Strands/Bedrock.
jest.unstable_mockModule("@readysetcloud/agent", () => ({ runAgent: jest.fn() }));

const { runAgent } = await import("@readysetcloud/agent");
const {
  runReadabilityLens,
  runLlmLens,
  runBrandLens,
  runSummaryLens,
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
