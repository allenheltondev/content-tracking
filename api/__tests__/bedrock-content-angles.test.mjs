import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

// suggestContentAngles runs on the shared @readysetcloud/agent runtime; mock
// runAgent so the suite verifies how it invokes it (prompt, input, schema,
// sampling config) without loading Strands/Bedrock.
jest.unstable_mockModule("@readysetcloud/agent", () => ({ runAgent: jest.fn() }));

const { runAgent } = await import("@readysetcloud/agent");
const { suggestContentAngles } = await import("../services/bedrock/angles.mjs");

const okRun = (output) => ({ output, text: JSON.stringify(output), structured: true, stopReason: "endTurn", invocationState: {} });

describe("services/bedrock suggestContentAngles", () => {
  beforeEach(() => jest.clearAllMocks());

  test("forces the content-angles schema and returns the structured output", async () => {
    runAgent.mockResolvedValueOnce(okRun({
      summary: "AI agents dominate the feeds.",
      themes: [{ theme: "agents", momentum: "surging" }],
      angles: [{ title: "Why agents fail", angle: "take", rationale: "timely", sources: [1] }],
    }));

    const result = await suggestContentAngles({
      items: [
        { title: "Agents everywhere", summary: "everyone is shipping agents", feedTitle: "AI Weekly", publishedAt: "2026-07-13T00:00:00.000Z" },
      ],
      voicePortraits: [{ platform: "blog", portrait: "You write blunt, example-first posts." }],
      recentTopics: ["Serverless event patterns"],
      interests: ["developer experience"],
      avoid: ["crypto"],
      audience: "senior backend engineers",
      platform: "blog",
      guidance: "be contrarian",
    });

    expect(result.summary).toBe("AI agents dominate the feeds.");
    expect(result.angles[0].title).toBe("Why agents fail");

    const call = runAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("structured result");
    expect(call.temperature).toBe(0.6);
    expect(call.maxTokens).toBe(3072);
    expect(call.maxIterations).toBe(1);

    // The zod schema enforces the angle shape: every angle needs a title, the
    // take itself, and a rationale; theme momentum is a closed enum.
    expect(call.outputSchema.safeParse({
      summary: "s",
      themes: [{ theme: "agents", momentum: "emerging", why_it_fits: "fits" }],
      angles: [{ title: "t", angle: "a", rationale: "r", format: "blog", sources: [1, 2] }],
    }).success).toBe(true);
    expect(call.outputSchema.safeParse({
      summary: "s",
      angles: [{ title: "t", angle: "a" }],
    }).success).toBe(false);
    expect(call.outputSchema.safeParse({
      summary: "s",
      themes: [{ theme: "agents", momentum: "exploding" }],
      angles: [],
    }).success).toBe(false);

    // The user message carries the numbered feed items, the voice portrait, and topics.
    const text = call.input;
    expect(text).toMatch(/\[1\] Agents everywhere/);
    expect(text).toMatch(/blunt, example-first/);
    expect(text).toMatch(/Serverless event patterns/);
    expect(text).toMatch(/Favor angles suited to: blog/);
    expect(text).toMatch(/be contrarian/);
    // The stated preferences are rendered as their own labeled sections.
    expect(text).toMatch(/LEAN INTO[\s\S]*developer experience/);
    expect(text).toMatch(/AVOID[\s\S]*crypto/);
    expect(text).toMatch(/WRITING FOR[\s\S]*senior backend engineers/);
  });

  test("notes an empty feed instead of inventing items", async () => {
    runAgent.mockResolvedValueOnce(okRun({ summary: "No feed items right now.", angles: [] }));

    const result = await suggestContentAngles({ items: [], voicePortraits: [], recentTopics: [] });
    expect(result.angles).toEqual([]);

    const text = runAgent.mock.calls[0][0].input;
    expect(text).toMatch(/no feed items available/i);
    expect(text).toMatch(/no learned voice yet/i);
  });
});
