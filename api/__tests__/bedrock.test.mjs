import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
const { summarizeBrief, reviewDraft } = await import("../services/bedrock.mjs");
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
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  test("forces the record_draft_review tool and folds the brief into the prompt", async () => {
    mockSend.mockResolvedValueOnce({
      stopReason: "tool_use",
      output: {
        message: {
          role: "assistant",
          content: [
            {
              toolUse: {
                name: "record_draft_review",
                input: { verdict: "minor_revisions", summary: "Solid, small tweaks." },
              },
            },
          ],
        },
      },
      usage: { inputTokens: 200, outputTokens: 80 },
    });

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

    const command = mockSend.mock.calls[0][0];
    expect(command.input.toolConfig.toolChoice.tool.name).toBe("record_draft_review");
    expect(command.input.system).toEqual(
      expect.arrayContaining([expect.objectContaining({ cachePoint: { type: "default" } })]),
    );

    const userText = command.input.messages[0].content[0].text;
    expect(userText).toContain("mention pricing");
    expect(userText).toContain("Here is my blog about Acme.");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(reviewDraft({ brief: {}, draftText: "x" })).rejects.toThrow(UpstreamError);
  });
});
