import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
const { recommendEngagement } = await import("../services/bedrock/engagement.mjs");
const { UpstreamError } = await import("../services/errors.mjs");

describe("services/bedrock recommendEngagement", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  const toolResponse = (input) => ({
    stopReason: "tool_use",
    output: {
      message: {
        role: "assistant",
        content: [{ toolUse: { name: "record_engagement_recommendations", input } }],
      },
    },
    usage: { inputTokens: 300, outputTokens: 120 },
  });

  test("forces the tool, caches the system prompt, and gives more token headroom", async () => {
    mockSend.mockResolvedValueOnce(toolResponse({
      summary: "Push it to dev communities.",
      recommendations: [
        { channel: "reddit r/webdev", action: "promote", priority: "high", rationale: "fits", suggested_message: "Try this" },
      ],
      already_covered: ["x"],
    }));

    const result = await recommendEngagement({
      contentPost: { platform: "medium", url: "https://medium.com/p/abc", notes: "deep dive" },
      campaign: { name: "Acme Q2", targetMetrics: { signups: 100 } },
      brief: { summary: "Promote Acme widgets", suggestedCampaign: { deliverables: [{ platform: "blog", type: "article", notes: "mention pricing" }] } },
      crossPostLinks: [{ platform: "x", url: "https://x.com/p/1" }],
      otherContentPosts: [{ platform: "devto", url: "https://dev.to/p/2" }],
      socialPosts: [{ platform: "linkedin", url: "https://linkedin.com/p/3", notes: "Excited to share my widget post!" }],
      contentText: "A hands-on guide to cutting build times by 40 percent.",
      goal: "developer signups",
    });

    expect(result.summary).toBe("Push it to dev communities.");
    expect(result.recommendations[0].channel).toBe("reddit r/webdev");

    const command = mockSend.mock.calls[0][0];
    expect(command.input.toolConfig.toolChoice.tool.name).toBe("record_engagement_recommendations");
    expect(command.input.inferenceConfig.maxTokens).toBe(3072);
    expect(command.input.system).toEqual(
      expect.arrayContaining([expect.objectContaining({ cachePoint: { type: "default" } })]),
    );

    // The distribution history the model must respect is folded into the prompt.
    const userText = command.input.messages[0].content[0].text;
    expect(userText).toContain("WORK ITEM");
    expect(userText).toContain("https://medium.com/p/abc");
    expect(userText).toContain("ALREADY CROSS-POSTED");
    expect(userText).toContain("https://x.com/p/1");
    expect(userText).toContain("https://dev.to/p/2");
    expect(userText).toContain("ALREADY SAID ON SOCIAL MEDIA");
    expect(userText).toContain("Excited to share my widget post!");
    expect(userText).toContain("mention pricing");
    expect(userText).toContain("developer signups");
    // The fetched page body is handed to the model as the topic signal.
    expect(userText).toContain("CONTENT (fetched from the work item URL)");
    expect(userText).toContain("A hands-on guide to cutting build times by 40 percent.");
  });

  test("notes when nothing has been distributed yet", async () => {
    mockSend.mockResolvedValueOnce(toolResponse({ summary: "Fresh.", recommendations: [] }));

    await recommendEngagement({
      contentPost: { platform: "medium", url: "https://medium.com/p/x" },
      campaign: { name: "New" },
      brief: null,
      crossPostLinks: [],
      otherContentPosts: [],
      socialPosts: [],
    });

    const userText = mockSend.mock.calls[0][0].input.messages[0].content[0].text;
    expect(userText).toContain("(none yet)");
    expect(userText).toContain("(nothing yet)");
    expect(userText).not.toContain("USER GUIDANCE");
    // No fetched body → the prompt tells the model to fall back to url/notes/brief.
    expect(userText).toContain("could not fetch the page text");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(
      recommendEngagement({ contentPost: { url: "u" }, crossPostLinks: [], otherContentPosts: [], socialPosts: [] }),
    ).rejects.toThrow(UpstreamError);
  });
});
