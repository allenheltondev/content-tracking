import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

// reviewDraft runs on the shared @readysetcloud/agent runtime (mocked here);
// summarizeBrief stays on the raw Converse tool-use path because it needs PDF
// document blocks + prompt caching, so its tests keep the SDK send mock.
jest.unstable_mockModule("@readysetcloud/agent", () => ({ runAgent: jest.fn() }));

const { runAgent } = await import("@readysetcloud/agent");
const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
const { summarizeBrief, reviewDraft } = await import("../services/bedrock/brief.mjs");
const { UpstreamError } = await import("../services/errors.mjs");

describe("services/bedrock summarizeBrief", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  const validToolUseResponse = (input) => ({
    stopReason: "tool_use",
    output: {
      message: {
        role: "assistant",
        content: [
          { toolUse: { name: "record_brief_summary", input } },
        ],
      },
    },
    usage: { inputTokens: 100, outputTokens: 50 },
  });

  describe("chat source", () => {
    test("requires text", async () => {
      await expect(summarizeBrief({ sourceType: "chat" })).rejects.toThrow(/text is required/);
    });

    test("happy path returns tool input", async () => {
      mockSend.mockResolvedValueOnce(validToolUseResponse({
        summary: "Vendor wants 2 reels.",
        suggested_campaign: { name: "Acme Q2" },
        warnings: [],
      }));

      const result = await summarizeBrief({
        sourceType: "chat",
        text: "vendor: Need 2 reels by June.",
      });

      expect(result.summary).toBe("Vendor wants 2 reels.");
      expect(result.suggested_campaign.name).toBe("Acme Q2");

      const command = mockSend.mock.calls[0][0];
      expect(command.input.modelId).toBe("us.amazon.nova-pro-v1:0");
      expect(command.input.system).toEqual(
        expect.arrayContaining([expect.objectContaining({ cachePoint: { type: "default" } })]),
      );
      expect(command.input.toolConfig.toolChoice.tool.name).toBe("record_brief_summary");
    });

    test("renders existing campaign + known vendors into the user message", async () => {
      mockSend.mockResolvedValueOnce(validToolUseResponse({
        summary: "ok",
        suggested_campaign: { name: "ok" },
      }));

      await summarizeBrief({
        sourceType: "chat",
        text: "vendor: hi",
        existingCampaign: {
          name: "Acme Q2",
          vendorId: "acme",
          sponsor: "Acme Inc.",
          startDate: "2026-06-01",
        },
        vendors: [
          { vendorId: "acme", name: "Acme Inc." },
          { vendorId: "globex", name: "Globex" },
        ],
      });

      const userText = mockSend.mock.calls[0][0].input.messages[0].content[0].text;
      expect(userText).toContain("Existing campaign:");
      expect(userText).toContain("name: Acme Q2");
      expect(userText).toContain("vendor_id: acme");
      expect(userText).toContain("Known vendors:");
      expect(userText).toContain("acme: Acme Inc.");
      expect(userText).toContain("globex: Globex");
    });

    test("omits context block when no campaign or vendors are provided", async () => {
      mockSend.mockResolvedValueOnce(validToolUseResponse({
        summary: "ok",
        suggested_campaign: { name: "ok" },
      }));

      await summarizeBrief({ sourceType: "chat", text: "vendor: hi" });

      const userText = mockSend.mock.calls[0][0].input.messages[0].content[0].text;
      expect(userText).not.toContain("Existing campaign");
      expect(userText).not.toContain("Known vendors");
    });
  });

  describe("pdf source", () => {
    test("requires pdfBytes", async () => {
      await expect(summarizeBrief({ sourceType: "pdf" })).rejects.toThrow(/pdfBytes is required/);
    });

    test("sends a document content block", async () => {
      mockSend.mockResolvedValueOnce(validToolUseResponse({
        summary: "PDF brief summary.",
        suggested_campaign: { name: "PDF Test" },
      }));

      const pdfBytes = Buffer.from("fake-pdf-bytes");
      await summarizeBrief({ sourceType: "pdf", pdfBytes });

      const command = mockSend.mock.calls[0][0];
      const userContent = command.input.messages[0].content;
      const docBlock = userContent.find((b) => b.document);
      expect(docBlock).toBeDefined();
      expect(docBlock.document.format).toBe("pdf");
    });
  });

  describe("error handling", () => {
    test("wraps Bedrock errors in UpstreamError", async () => {
      mockSend.mockRejectedValueOnce(new Error("throttled"));
      await expect(
        summarizeBrief({ sourceType: "chat", text: "x" }),
      ).rejects.toThrow(UpstreamError);
    });

    test("throws when no tool_use block is present", async () => {
      mockSend.mockResolvedValueOnce({
        stopReason: "end_turn",
        output: { message: { content: [{ text: "I refuse." }] } },
      });

      let thrown;
      try {
        await summarizeBrief({ sourceType: "chat", text: "x" });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(UpstreamError);
      expect(thrown.rawModelOutput).toBe("I refuse.");
    });
  });

  test("rejects unsupported source types", async () => {
    await expect(
      summarizeBrief({ sourceType: "audio" }),
    ).rejects.toThrow(/Unsupported source_type/);
  });
});

describe("services/bedrock reviewDraft", () => {
  beforeEach(() => jest.clearAllMocks());

  const okRun = (output) => ({ output, text: JSON.stringify(output), structured: true, stopReason: "endTurn", invocationState: {} });

  test("forces the draft-review schema and folds the brief into the prompt", async () => {
    runAgent.mockResolvedValueOnce(okRun({ verdict: "minor_revisions", summary: "Solid, small tweaks." }));

    const review = await reviewDraft({
      brief: {
        summary: "Promote Acme widgets",
        suggestedCampaign: {
          name: "Acme Q2",
          deliverables: [{ platform: "blog", type: "article", count: 1, notes: "mention pricing" }],
        },
      },
      draftText: "Here is my blog about Acme.",
    });

    expect(review.verdict).toBe("minor_revisions");

    const call = runAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("structured result");
    expect(call.temperature).toBe(0.3);
    expect(call.maxTokens).toBe(2048);
    expect(call.maxIterations).toBe(1);

    // The zod schema closes the verdict enum, requires the summary, and
    // requires severity + detail on every issue.
    expect(call.outputSchema.safeParse({
      verdict: "ready", summary: "s",
      issues: [{ severity: "high", detail: "d", suggestion: "fix" }],
      missing_requirements: ["cta"],
    }).success).toBe(true);
    expect(call.outputSchema.safeParse({ verdict: "publish_now", summary: "s" }).success).toBe(false);
    expect(call.outputSchema.safeParse({
      verdict: "ready", summary: "s", issues: [{ severity: "high" }],
    }).success).toBe(false);

    const userText = call.input;
    expect(userText).toContain("mention pricing");
    expect(userText).toContain("Here is my blog about Acme.");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    runAgent.mockRejectedValueOnce(new Error("throttled"));
    await expect(reviewDraft({ brief: {}, draftText: "x" })).rejects.toThrow(UpstreamError);
  });
});
