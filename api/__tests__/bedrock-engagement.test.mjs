import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

// recommendEngagement runs on the shared @readysetcloud/agent runtime; mock
// runAgent so the suite verifies how it invokes it (prompt, input, schema,
// sampling config) without loading Strands/Bedrock.
jest.unstable_mockModule("@readysetcloud/agent", () => ({ runAgent: jest.fn() }));

const { runAgent } = await import("@readysetcloud/agent");
const { recommendEngagement } = await import("../services/bedrock/engagement.mjs");
const { UpstreamError } = await import("../services/errors.mjs");

const okRun = (output) => ({ output, text: JSON.stringify(output), structured: true, stopReason: "endTurn", invocationState: {} });

describe("services/bedrock recommendEngagement", () => {
  beforeEach(() => jest.clearAllMocks());

  test("forces the recommendations schema and gives more token headroom", async () => {
    runAgent.mockResolvedValueOnce(okRun({
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

    const call = runAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("record_engagement_recommendations");
    expect(call.temperature).toBe(0.5);
    expect(call.maxTokens).toBe(3072);
    expect(call.maxIterations).toBe(1);

    // The zod schema enforces the recommendation shape: every entry needs a
    // channel, a valid action/priority, a rationale, and a suggested message.
    expect(call.outputSchema.safeParse({
      summary: "s",
      recommendations: [
        { channel: "hn", action: "promote", priority: "medium", rationale: "r", suggested_message: "m" },
      ],
    }).success).toBe(true);
    expect(call.outputSchema.safeParse({
      summary: "s",
      recommendations: [
        { channel: "hn", action: "repost", priority: "medium", rationale: "r", suggested_message: "m" },
      ],
    }).success).toBe(false);
    expect(call.outputSchema.safeParse({ summary: "s" }).success).toBe(false);

    // The distribution history the model must respect is folded into the prompt.
    const userText = call.input;
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
    runAgent.mockResolvedValueOnce(okRun({ summary: "Fresh.", recommendations: [] }));

    await recommendEngagement({
      contentPost: { platform: "medium", url: "https://medium.com/p/x" },
      campaign: { name: "New" },
      brief: null,
      crossPostLinks: [],
      otherContentPosts: [],
      socialPosts: [],
    });

    const userText = runAgent.mock.calls[0][0].input;
    expect(userText).toContain("(none yet)");
    expect(userText).toContain("(nothing yet)");
    expect(userText).not.toContain("USER GUIDANCE");
    // No fetched body → the prompt tells the model to fall back to url/notes/brief.
    expect(userText).toContain("could not fetch the page text");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    runAgent.mockRejectedValueOnce(new Error("throttled"));
    await expect(
      recommendEngagement({ contentPost: { url: "u" }, crossPostLinks: [], otherContentPosts: [], socialPosts: [] }),
    ).rejects.toThrow(UpstreamError);
  });
});
