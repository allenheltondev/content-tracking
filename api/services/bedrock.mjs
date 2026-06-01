import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { logger } from "./logger.mjs";
import { UpstreamError } from "./errors.mjs";

// Bedrock client used by the brief pipeline. Wraps the Converse API
// so route code doesn't have to know about content-block shapes or
// tool-use plumbing. Prompt caching is on by default — the system
// prompt is large and identical across every brief, which is exactly
// the workload prompt caching is for.

const MODEL_ID = process.env.BEDROCK_MODEL_ID;
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";

const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

// The tool the model is forced to call. Returning structured JSON via
// tool-use is far more reliable than asking the model to emit JSON in
// prose — the tool args go through the API's schema validation rather
// than a regex on text output.
const RECORD_BRIEF_TOOL = {
  toolSpec: {
    name: "record_brief_summary",
    description:
      "Record the structured extraction of an influencer marketing brief.",
    inputSchema: {
      json: {
        type: "object",
        required: ["summary", "suggested_campaign"],
        properties: {
          summary: {
            type: "string",
            description:
              "One-paragraph plain-English summary of what the brief asks for, who the vendor is, and any standout requirements or constraints.",
          },
          suggested_campaign: {
            type: "object",
            required: ["name"],
            properties: {
              name: {
                type: "string",
                description: "A short campaign name suitable for a Campaign record.",
              },
              vendor: {
                type: "object",
                properties: {
                  vendor_id: {
                    type: "string",
                    description:
                      "If the brief's vendor matches one in the Known vendors list, set this to that vendor_id. Leave unset when no match is confident.",
                  },
                  name_hint: {
                    type: "string",
                    description:
                      "The vendor (brand) name as it should appear on the campaign. Match the spelling of an existing vendor when one applies; otherwise the brand the brief is promoting — NOT an intermediary agency.",
                  },
                },
              },
              startDate: {
                type: "string",
                description: "YYYY-MM-DD or null if not stated.",
              },
              endDate: {
                type: "string",
                description: "YYYY-MM-DD or null if not stated.",
              },
              deliverables: {
                type: "array",
                items: {
                  type: "object",
                  required: ["platform", "type"],
                  properties: {
                    platform: {
                      type: "string",
                      description:
                        "Lowercase platform handle: instagram, youtube, tiktok, x, bluesky, linkedin, medium, blog, ...",
                    },
                    type: {
                      type: "string",
                      description:
                        "Lowercase content type: reel, post, story, video, livestream, article, ...",
                    },
                    count: {
                      type: "integer",
                      minimum: 1,
                      description: "Number of deliverables of this kind. Default 1 if unspecified.",
                    },
                    notes: {
                      type: "string",
                      description: "Free-form notes specific to this deliverable (length, tone, must-mention features).",
                    },
                  },
                },
              },
              payout: {
                type: "object",
                description: "Only fill in if the brief states a dollar amount or rate.",
                properties: {
                  amount: { type: "number" },
                  currency: { type: "string", description: "ISO 4217 (USD, EUR, ...). Default USD if unstated." },
                },
              },
              targetMetrics: {
                type: "object",
                description: "Any quantitative goals the brief mentions (impressions, CTR, signups).",
              },
            },
          },
          warnings: {
            type: "array",
            description: "Anything missing, ambiguous, or worth flagging to the user before they accept this draft.",
            items: { type: "string" },
          },
        },
      },
    },
  },
};

// The system prompt is large and stable, so we mark it cacheable. Bedrock
// returns cache-hit indicators on the response which we log for visibility.
const SYSTEM_PROMPT = `You are an assistant that extracts structured information from influencer marketing briefs. Briefs arrive in two forms:

1. PDFs attached to the request as a document content block.
2. Chat transcripts pasted as plain text (vendor / influencer back-and-forth).

For each brief, do all of the following and return them by calling the record_brief_summary tool:

- Read the brief and produce a one-paragraph plain-English summary covering: who the vendor is, what the work is, key deliverables, timeline, and any compensation mentioned.
- Identify the suggested Campaign metadata: a short name, the vendor's name, start and end dates (YYYY-MM-DD), the deliverables list, and the payout amount + currency if stated.
- For each deliverable, give platform (instagram, youtube, tiktok, x, blog, ...) and content type (reel, post, video, article, ...) in lowercase, plus count (default 1) and notes describing tone, length, or must-mention features.
- Surface warnings for anything missing, ambiguous, or that the user should confirm before accepting the draft.

Vendor vs agency: the vendor is the company whose product or brand is being promoted. If the brief is sent by a marketing or PR agency representing a brand, the agency is NOT the vendor — the brand they represent is. Pull the vendor from the body of the brief (the product being promoted), not from the sender's signature or the cover letter. Call this out in a warning when an agency is acting as a proxy.

Existing context: the user message may include an "Existing campaign" block (fields already set on this campaign — treat as ground truth; only suggest changes when the brief contradicts or adds to them) and a "Known vendors" block (vendors already in the system, with their vendor_id and name). When the brief's vendor matches one of the known vendors, set suggested_campaign.vendor.vendor_id to that exact id and use the known vendor's name in name_hint — do not invent a new spelling. Leave vendor_id unset when no known vendor clearly matches.

Be conservative. If a field is genuinely not stated in the brief, leave it off rather than guessing. Add a warning instead. Currency defaults to USD only when an amount is given without a currency. Do not write prose — only call the tool.`;

// Calls Bedrock Converse with the appropriate content for the source type.
// `pdfBytes` is a Buffer; pass it for PDF briefs. `text` is the chat
// transcript for chat briefs. Exactly one should be set.
//
// `existingCampaign` is the campaign row this brief is being attached to
// (so the model knows what's already set and doesn't re-suggest it).
// `vendors` is the list of known vendors so the model can match by id
// rather than fabricating a new spelling. Both are optional.
export async function summarizeBrief({ sourceType, pdfBytes, text, existingCampaign, vendors }) {
  if (!MODEL_ID) {
    throw new Error("BEDROCK_MODEL_ID env var is not set");
  }

  const contextBlock = formatBriefContext({ existingCampaign, vendors });
  const userContent = [];

  if (sourceType === "pdf") {
    if (!pdfBytes) throw new Error("pdfBytes is required for source_type=pdf");
    userContent.push({
      document: {
        format: "pdf",
        name: "brief",
        source: { bytes: pdfBytes },
      },
    });
    userContent.push({
      text: `Extract the structured summary from this brief by calling the record_brief_summary tool.${contextBlock}`,
    });
  } else if (sourceType === "chat") {
    if (!text) throw new Error("text is required for source_type=chat");
    userContent.push({
      text: `Extract the structured summary from the following chat transcript by calling the record_brief_summary tool.${contextBlock}\n\n--- BEGIN TRANSCRIPT ---\n${text}\n--- END TRANSCRIPT ---`,
    });
  } else {
    throw new Error(`Unsupported source_type: ${sourceType}`);
  }

  return invokeToolUse({
    system: SYSTEM_PROMPT,
    userContent,
    tool: RECORD_BRIEF_TOOL,
  });
}

// Renders the per-call context (existing campaign fields + known vendors)
// that the system prompt tells the model to consult. Returns "" when both
// inputs are empty so the user message stays clean.
function formatBriefContext({ existingCampaign, vendors }) {
  const sections = [];

  if (existingCampaign) {
    const lines = [];
    const c = existingCampaign;
    if (c.name) lines.push(`name: ${c.name}`);
    if (c.vendorId) lines.push(`vendor_id: ${c.vendorId}`);
    if (c.sponsor) lines.push(`sponsor (display name): ${c.sponsor}`);
    if (c.startDate) lines.push(`startDate: ${c.startDate}`);
    if (c.endDate) lines.push(`endDate: ${c.endDate}`);
    if (c.status) lines.push(`status: ${c.status}`);
    if (c.payout?.amount !== undefined) {
      const currency = c.payout.currency ?? "USD";
      lines.push(`payout: ${c.payout.amount} ${currency}`);
    }
    if (c.targetMetrics && Object.keys(c.targetMetrics).length > 0) {
      lines.push(`targetMetrics: ${JSON.stringify(c.targetMetrics)}`);
    }
    if (lines.length > 0) {
      sections.push(`Existing campaign:\n${lines.map((l) => `  ${l}`).join("\n")}`);
    } else {
      sections.push("Existing campaign: (no fields set yet)");
    }
  }

  if (Array.isArray(vendors) && vendors.length > 0) {
    const lines = vendors.map((v) => `  - ${v.vendorId}: ${v.name}`);
    sections.push(`Known vendors:\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

// Tool the model is forced to call when reviewing a draft. Same rationale
// as RECORD_BRIEF_TOOL: structured tool args beat parsing prose.
const RECORD_DRAFT_REVIEW_TOOL = {
  toolSpec: {
    name: "record_draft_review",
    description:
      "Record structured editorial feedback on a blog draft, assessed against its campaign brief.",
    inputSchema: {
      json: {
        type: "object",
        required: ["verdict", "summary"],
        properties: {
          verdict: {
            type: "string",
            enum: ["ready", "minor_revisions", "major_revisions"],
            description:
              "Overall readiness: 'ready' to publish, 'minor_revisions' for small fixes, 'major_revisions' for substantial work.",
          },
          summary: {
            type: "string",
            description: "One-paragraph overall assessment of the draft.",
          },
          brief_alignment: {
            type: "string",
            description:
              "How well the draft fulfills the brief's deliverables, required topics, tone, and must-mention features.",
          },
          strengths: {
            type: "array",
            description: "Specific things the draft does well.",
            items: { type: "string" },
          },
          issues: {
            type: "array",
            description: "Concrete, actionable problems to fix before publishing.",
            items: {
              type: "object",
              required: ["severity", "detail"],
              properties: {
                severity: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                },
                area: {
                  type: "string",
                  description:
                    "What the issue is about: brief-coverage, structure, tone, accuracy, clarity, cta, seo, ...",
                },
                detail: {
                  type: "string",
                  description: "What's wrong, referencing the relevant part of the draft.",
                },
                suggestion: {
                  type: "string",
                  description: "How to fix it.",
                },
              },
            },
          },
          missing_requirements: {
            type: "array",
            description:
              "Brief requirements (deliverables, must-mention features, CTAs) the draft does not address.",
            items: { type: "string" },
          },
        },
      },
    },
  },
};

const REVIEW_SYSTEM_PROMPT = `You are an experienced content editor reviewing a blog draft against the campaign brief it was written for. You are given the brief (summary, deliverables, target metrics, and any must-mention requirements) and the full draft text.

Review the draft and return your feedback by calling the record_draft_review tool. Assess:

- Brief alignment: does the draft cover every required deliverable, topic, and must-mention feature? Is the tone and length appropriate for the brief? Surface anything the brief asks for that the draft omits in missing_requirements.
- Quality: structure and flow, clarity, accuracy of claims, and whether the introduction and conclusion are effective.
- Calls to action and links: does the draft include the CTAs the brief expects?
- Strengths: call out what genuinely works so the writer knows what to keep.

Be specific and actionable. Every issue should reference the relevant part of the draft and include a concrete suggestion. Do not invent requirements the brief doesn't state. Choose a verdict honestly: 'ready' only when you'd publish as-is, 'minor_revisions' for small polish, 'major_revisions' when the draft misses brief requirements or needs substantial rework. Do not write prose — only call the tool.`;

// Reviews a blog draft against its campaign brief. `brief` is the stored
// brief item (summary + suggestedCampaign + warnings); `draftText` is the
// plain-text draft pulled from Google Docs.
export async function reviewDraft({ brief, draftText }) {
  const briefBlock = formatBriefForReview(brief);
  const userContent = [{
    text: `Review the following blog draft against its campaign brief by calling the record_draft_review tool.\n\n=== CAMPAIGN BRIEF ===\n${briefBlock}\n\n=== DRAFT ===\n${draftText}\n=== END DRAFT ===`,
  }];

  return invokeToolUse({
    system: REVIEW_SYSTEM_PROMPT,
    userContent,
    tool: RECORD_DRAFT_REVIEW_TOOL,
    // Reviewing is a touch more generative than extraction; a little
    // headroom helps the model phrase suggestions without going off-piste.
    temperature: 0.3,
  });
}

// Renders the stored brief into a readable block for the review prompt.
// Deliverables and target metrics matter most — they're what the draft is
// measured against.
function formatBriefForReview(brief) {
  const lines = [];
  if (brief?.summary) lines.push(`Summary: ${brief.summary}`);

  const sc = brief?.suggestedCampaign;
  if (sc?.name) lines.push(`Campaign: ${sc.name}`);
  if (Array.isArray(sc?.deliverables) && sc.deliverables.length > 0) {
    lines.push("Deliverables:");
    for (const d of sc.deliverables) {
      const count = d.count ?? 1;
      const notes = d.notes ? ` — ${d.notes}` : "";
      lines.push(`  - ${count}x ${d.platform ?? "?"} ${d.type ?? ""}${notes}`.trimEnd());
    }
  }
  if (sc?.targetMetrics && Object.keys(sc.targetMetrics).length > 0) {
    lines.push(`Target metrics: ${JSON.stringify(sc.targetMetrics)}`);
  }
  if (Array.isArray(brief?.warnings) && brief.warnings.length > 0) {
    lines.push(`Brief warnings: ${brief.warnings.join("; ")}`);
  }

  return lines.join("\n");
}

// Tool the model is forced to call when recommending where else to push a
// piece of content. Structured tool args beat parsing prose, same as the
// brief and draft-review pipelines.
const RECORD_ENGAGEMENT_RECOMMENDATIONS_TOOL = {
  toolSpec: {
    name: "record_engagement_recommendations",
    description:
      "Record recommendations for where else to cross-post or promote a piece of content to boost engagement.",
    inputSchema: {
      json: {
        type: "object",
        required: ["summary", "recommendations"],
        properties: {
          summary: {
            type: "string",
            description:
              "One- or two-sentence overall distribution strategy for this piece, grounded in where it has and hasn't been shared yet.",
          },
          recommendations: {
            type: "array",
            description:
              "Concrete places to cross-post or promote this content, strongest first. Aim for 3-6 high-quality entries, not a long generic list.",
            items: {
              type: "object",
              required: ["channel", "action", "priority", "rationale", "suggested_message"],
              properties: {
                channel: {
                  type: "string",
                  description:
                    "The platform or venue, as specific as possible: linkedin, x, bluesky, a named subreddit (reddit r/webdev), hacker news, a relevant newsletter, mastodon, a youtube community post, ...",
                },
                action: {
                  type: "string",
                  enum: ["cross_post", "promote"],
                  description:
                    "'cross_post' to republish the full piece on that channel; 'promote' to share a link or teaser that drives traffic back to the original.",
                },
                priority: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                  description: "Expected payoff relative to effort, given audience fit.",
                },
                rationale: {
                  type: "string",
                  description:
                    "Why this channel fits this content and audience, and why it extends reach rather than duplicating somewhere it's already shared.",
                },
                suggested_message: {
                  type: "string",
                  description:
                    "A ready-to-use caption or post tailored to that channel's norms and length, with a fresh angle that does NOT restate what was already said on social media.",
                },
              },
            },
          },
          already_covered: {
            type: "array",
            description:
              "Channels or venues this content is already cross-posted to or has already been promoted on, so the user can see they were considered and intentionally skipped.",
            items: { type: "string" },
          },
        },
      },
    },
  },
};

const ENGAGEMENT_SYSTEM_PROMPT = `You are a content distribution and audience-growth strategist for a solo content creator. You are given a single published piece of content (the "work item") — usually including the page text we fetched from its URL — plus everything we already know about how it and its campaign have been distributed: the campaign brief, where the piece is already cross-posted, the other content pieces in the same campaign, and the social-media posts that have already promoted it.

Ground your recommendations in what the piece is actually about. When the fetched content is present, use it to judge topic, depth, and tone; when it could not be fetched, fall back to the URL, notes, and brief.

Recommend additional places the creator should cross-post or promote this content to boost engagement, by calling the record_engagement_recommendations tool. For each recommendation provide channel, action (cross_post or promote), priority, a rationale, and a ready-to-use suggested_message.

Rules:
- Do NOT recommend a channel the content is already cross-posted to or has already been promoted on. List those under already_covered instead so the user sees they were considered and skipped.
- Vary the angle across recommendations; every suggested_message must say something fresh and must not restate the existing social copy you were shown.
- Favor channels that match the content's platform and topic, and where this creator's audience plausibly is. Quality over quantity — 3 to 6 strong recommendations beat a long generic list.
- cross_post is for channels where republishing the full piece makes sense (and note canonical/duplicate-content concerns in the rationale when relevant); promote is for sharing a link or teaser.
- Be concrete and practical. Do not write prose outside the tool — only call the record_engagement_recommendations tool.`;

// Recommends where else to cross-post or promote a content piece. `contentPost`
// is the work item (platform, url, notes). The remaining inputs are the
// distribution context the system prompt tells the model to respect:
// `brief` (what the campaign is about), `crossPostLinks` (where it's already
// cross-posted), `otherContentPosts` (sibling pieces in the campaign), and
// `socialPosts` (what's already been said on social media). `goal` is optional
// free-text guidance from the caller. All context is best-effort — missing
// pieces just mean the prompt has less to work with.
export async function recommendEngagement({
  contentPost,
  campaign,
  brief,
  crossPostLinks,
  otherContentPosts,
  socialPosts,
  contentText,
  goal,
}) {
  const contextBlock = formatEngagementContext({
    contentPost,
    campaign,
    brief,
    crossPostLinks,
    otherContentPosts,
    socialPosts,
    contentText,
    goal,
  });

  const userContent = [{
    text: `Recommend where else to cross-post or promote this content by calling the record_engagement_recommendations tool.\n\n${contextBlock}`,
  }];

  return invokeToolUse({
    system: ENGAGEMENT_SYSTEM_PROMPT,
    userContent,
    tool: RECORD_ENGAGEMENT_RECOMMENDATIONS_TOOL,
    // Distribution ideas and channel-specific copy are the most generative
    // of the three pipelines, so give the model the most headroom.
    temperature: 0.5,
    maxTokens: 3072,
  });
}

// Renders the work item plus its distribution history into the readable block
// the engagement prompt reasons over. The "already cross-posted" and "already
// said on social" sections are what keep the model from recommending channels
// the creator has already used.
function formatEngagementContext({
  contentPost,
  campaign,
  brief,
  crossPostLinks,
  otherContentPosts,
  socialPosts,
  contentText,
  goal,
}) {
  const sections = [];

  const workItem = ["=== WORK ITEM (the content to boost) ==="];
  if (contentPost?.platform) workItem.push(`platform: ${contentPost.platform}`);
  if (contentPost?.url) workItem.push(`url: ${contentPost.url}`);
  if (contentPost?.notes) workItem.push(`notes: ${contentPost.notes}`);
  sections.push(workItem.join("\n"));

  // The fetched body is the strongest signal for what the piece is actually
  // about — when we have it, the recommendations key off the real content
  // rather than just the title/URL. It's best-effort, so it's often absent.
  if (typeof contentText === "string" && contentText.trim().length > 0) {
    sections.push(`=== CONTENT (fetched from the work item URL) ===\n${contentText.trim()}`);
  } else {
    sections.push(
      "=== CONTENT (fetched from the work item URL) ===\n(could not fetch the page text; base your read of the topic on the work item url, notes, and campaign brief)",
    );
  }

  const campaignLines = [];
  if (campaign?.name) campaignLines.push(`name: ${campaign.name}`);
  if (brief?.summary) campaignLines.push(`brief: ${brief.summary}`);
  const deliverables = brief?.suggestedCampaign?.deliverables;
  if (Array.isArray(deliverables) && deliverables.length > 0) {
    campaignLines.push("deliverables:");
    for (const d of deliverables) {
      const count = d.count ?? 1;
      const notes = d.notes ? ` — ${d.notes}` : "";
      campaignLines.push(`  - ${count}x ${d.platform ?? "?"} ${d.type ?? ""}${notes}`.trimEnd());
    }
  }
  if (campaign?.targetMetrics && Object.keys(campaign.targetMetrics).length > 0) {
    campaignLines.push(`target metrics: ${JSON.stringify(campaign.targetMetrics)}`);
  }
  if (campaignLines.length > 0) {
    sections.push(`=== CAMPAIGN CONTEXT ===\n${campaignLines.join("\n")}`);
  }

  const crossPosts = Array.isArray(crossPostLinks) ? crossPostLinks : [];
  const siblings = Array.isArray(otherContentPosts) ? otherContentPosts : [];
  const coveredLines = [];
  for (const l of crossPosts) {
    coveredLines.push(`  - ${l.platform ?? "?"} (cross-post link): ${l.url ?? l.shortUrl ?? ""}`.trimEnd());
  }
  for (const p of siblings) {
    coveredLines.push(`  - ${p.platform ?? "?"} (content piece): ${p.url ?? ""}`.trimEnd());
  }
  sections.push(
    coveredLines.length > 0
      ? `=== ALREADY CROSS-POSTED / DISTRIBUTED (do not re-recommend) ===\n${coveredLines.join("\n")}`
      : "=== ALREADY CROSS-POSTED / DISTRIBUTED (do not re-recommend) ===\n  (none yet)",
  );

  const socials = Array.isArray(socialPosts) ? socialPosts : [];
  const socialLines = [];
  for (const s of socials) {
    const said = s.notes ? ` — said: ${s.notes}` : "";
    socialLines.push(`  - ${s.platform ?? "?"}: ${s.url ?? ""}${said}`.trimEnd());
  }
  sections.push(
    socialLines.length > 0
      ? `=== ALREADY SAID ON SOCIAL MEDIA (don't repeat these angles) ===\n${socialLines.join("\n")}`
      : "=== ALREADY SAID ON SOCIAL MEDIA (don't repeat these angles) ===\n  (nothing yet)",
  );

  if (typeof goal === "string" && goal.length > 0) {
    sections.push(`=== USER GUIDANCE ===\n${goal}`);
  }

  return sections.join("\n\n");
}

// Shared Converse plumbing: forces a single tool call, marks the system
// prompt cacheable, logs usage, and returns the tool input. The brief,
// draft-review, and engagement-recommendation pipelines all run through here.
async function invokeToolUse({ system, userContent, tool, temperature = 0.1, maxTokens = 2048 }) {
  if (!MODEL_ID) {
    throw new Error("BEDROCK_MODEL_ID env var is not set");
  }

  const toolName = tool.toolSpec.name;
  const command = new ConverseCommand({
    modelId: MODEL_ID,
    system: [
      { text: system },
      // Cache breakpoint at the end of the system prompt — every call
      // after the first within the cache window (~5 minutes) skips the
      // prefix recompute.
      { cachePoint: { type: "default" } },
    ],
    messages: [{ role: "user", content: userContent }],
    toolConfig: {
      tools: [tool],
      toolChoice: { tool: { name: toolName } },
    },
    inferenceConfig: {
      maxTokens,
      temperature,
    },
  });

  let response;
  try {
    response = await bedrock.send(command);
  } catch (err) {
    logger.error("Bedrock Converse failed", {
      modelId: MODEL_ID,
      tool: toolName,
      error: err?.message,
      name: err?.name,
    });
    throw new UpstreamError(`Bedrock call failed: ${err?.message ?? "unknown"}`, 502);
  }

  // Log cache stats for visibility when tuning the prompt.
  if (response.usage) {
    logger.info("Bedrock usage", {
      tool: toolName,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadInputTokens: response.usage.cacheReadInputTokens,
      cacheWriteInputTokens: response.usage.cacheWriteInputTokens,
    });
  }

  const toolUse = extractToolUse(response, toolName);
  if (!toolUse) {
    const rawText = extractRawText(response);
    logger.error("Bedrock response had no tool_use block", {
      tool: toolName,
      stopReason: response.stopReason,
      rawText,
    });
    const err = new UpstreamError(
      "Bedrock returned no tool_use block. See logs for raw model output.",
      502,
    );
    err.rawModelOutput = rawText;
    throw err;
  }

  return toolUse;
}

function extractToolUse(response, toolName) {
  const content = response?.output?.message?.content ?? [];
  for (const block of content) {
    if (block.toolUse?.name === toolName) {
      return block.toolUse.input;
    }
  }
  return null;
}

function extractRawText(response) {
  const content = response?.output?.message?.content ?? [];
  const texts = [];
  for (const block of content) {
    if (typeof block.text === "string") texts.push(block.text);
  }
  return texts.join("\n");
}
