import { jest } from "@jest/globals";

process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
process.env.BEDROCK_REGION = "us-east-1";

const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
const { summarizeBrief, reviewDraft, recommendEngagement, answerBlogQuestion, answerContentQuestion, composeVoicePost, reflectVoiceProfile } = await import("../services/bedrock.mjs");
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

describe("services/bedrock answerBlogQuestion", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  const answerResponse = (input) => ({
    stopReason: "tool_use",
    output: {
      message: {
        role: "assistant",
        content: [{ toolUse: { name: "record_blog_answer", input } }],
      },
    },
    usage: { inputTokens: 150, outputTokens: 60 },
  });

  test("forces the record_blog_answer tool and numbers the source excerpts", async () => {
    mockSend.mockResolvedValueOnce(answerResponse({
      answer: "You covered build caching.",
      sources_used: [2],
      confidence: "high",
    }));

    const result = await answerBlogQuestion({
      question: "What have I written about caching?",
      chunks: [
        { blogId: "B1", title: "Faster Builds", text: "cut build time" },
        { blogId: "B2", title: "Caching Layers", text: "cache between layers" },
      ],
    });

    expect(result.answer).toBe("You covered build caching.");
    expect(result.sources_used).toEqual([2]);

    const command = mockSend.mock.calls[0][0];
    expect(command.input.toolConfig.toolChoice.tool.name).toBe("record_blog_answer");
    expect(command.input.system).toEqual(
      expect.arrayContaining([expect.objectContaining({ cachePoint: { type: "default" } })]),
    );

    const userText = command.input.messages[0].content[0].text;
    expect(userText).toContain("What have I written about caching?");
    // Excerpts are numbered 1-based with their titles and bodies.
    expect(userText).toContain('[1] "Faster Builds"');
    expect(userText).toContain("[2] \"Caching Layers\"");
    expect(userText).toContain("cache between layers");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(
      answerBlogQuestion({ question: "q", chunks: [{ blogId: "B1", title: "T", text: "x" }] }),
    ).rejects.toThrow(UpstreamError);
  });
});

describe("services/bedrock answerContentQuestion", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    BedrockRuntimeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  const answerResponse = (input) => ({
    stopReason: "tool_use",
    output: {
      message: {
        role: "assistant",
        content: [{ toolUse: { name: "record_content_answer", input } }],
      },
    },
    usage: { inputTokens: 150, outputTokens: 60 },
  });

  test("forces the record_content_answer tool and numbers the source excerpts", async () => {
    mockSend.mockResolvedValueOnce(answerResponse({
      answer: "You covered build caching.",
      sources_used: [2],
      confidence: "high",
    }));

    const result = await answerContentQuestion({
      question: "What have I written about caching?",
      chunks: [
        { contentId: "C1", title: "Faster Builds", text: "cut build time" },
        { contentId: "C2", title: "Caching Layers", text: "cache between layers" },
      ],
    });

    expect(result.answer).toBe("You covered build caching.");
    expect(result.sources_used).toEqual([2]);

    const command = mockSend.mock.calls[0][0];
    expect(command.input.toolConfig.toolChoice.tool.name).toBe("record_content_answer");
    expect(command.input.system).toEqual(
      expect.arrayContaining([expect.objectContaining({ cachePoint: { type: "default" } })]),
    );

    const userText = command.input.messages[0].content[0].text;
    expect(userText).toContain("What have I written about caching?");
    // Excerpts are numbered 1-based with their titles and bodies.
    expect(userText).toContain('[1] "Faster Builds"');
    expect(userText).toContain("[2] \"Caching Layers\"");
    expect(userText).toContain("cache between layers");
  });

  test("wraps Bedrock errors in UpstreamError", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(
      answerContentQuestion({ question: "q", chunks: [{ contentId: "C1", title: "T", text: "x" }] }),
    ).rejects.toThrow(UpstreamError);
  });
});

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

  test("wraps Bedrock errors in UpstreamError", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(
      composeVoicePost({ topic: "t", platform: "x", format: "social", profile: null, samples: [] }),
    ).rejects.toThrow(UpstreamError);
  });
});
