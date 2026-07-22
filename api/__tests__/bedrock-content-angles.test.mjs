import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
const { suggestContentAngles } = await import("../services/bedrock/angles.mjs");

describe("services/bedrock suggestContentAngles", () => {
  let mockSend;
  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  const toolResponse = (input) => ({
    stopReason: "tool_use",
    output: { message: { role: "assistant", content: [{ toolUse: { name: "record_content_angles", input } }] } },
    usage: { inputTokens: 100, outputTokens: 50 },
  });

  test("forces the record_content_angles tool and returns its input", async () => {
    mockSend.mockResolvedValueOnce(toolResponse({
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

    const command = mockSend.mock.calls[0][0];
    expect(command.input.toolConfig.toolChoice.tool.name).toBe("record_content_angles");
    // System prompt is cache-marked, same as the other pipelines.
    expect(command.input.system).toEqual(
      expect.arrayContaining([expect.objectContaining({ cachePoint: { type: "default" } })]),
    );

    // The user message carries the numbered feed items, the voice portrait, and topics.
    const text = command.input.messages[0].content[0].text;
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
    mockSend.mockResolvedValueOnce(toolResponse({ summary: "No feed items right now.", angles: [] }));

    const result = await suggestContentAngles({ items: [], voicePortraits: [], recentTopics: [] });
    expect(result.angles).toEqual([]);

    const text = mockSend.mock.calls[0][0].input.messages[0].content[0].text;
    expect(text).toMatch(/no feed items available/i);
    expect(text).toMatch(/no learned voice yet/i);
  });
});
