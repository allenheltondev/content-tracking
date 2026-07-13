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

// Tool the model is forced to call when answering a question about the blog
// catalog. Structured args keep the grounded answer, the sources it actually
// used, and a self-assessed confidence cleanly separated.
const RECORD_BLOG_ANSWER_TOOL = {
  toolSpec: {
    name: "record_blog_answer",
    description:
      "Record an answer to a question about the creator's blog catalog, grounded only in the provided excerpts.",
    inputSchema: {
      json: {
        type: "object",
        required: ["answer", "sources_used", "confidence"],
        properties: {
          answer: {
            type: "string",
            description:
              "The answer, written for the creator, grounded ONLY in the provided source excerpts. If the excerpts don't contain the answer, say so plainly rather than guessing.",
          },
          sources_used: {
            type: "array",
            description:
              "The [n] source numbers whose excerpts the answer actually draws on. Empty when no source was relevant.",
            items: { type: "integer", minimum: 1 },
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
            description:
              "How well the excerpts support the answer: 'high' when they directly and fully answer it, 'low' when they barely touch it or don't.",
          },
        },
      },
    },
  },
};

const BLOG_QA_SYSTEM_PROMPT = `You are a research assistant for a content creator, answering questions about THEIR OWN past blog posts. You are given the question and a set of numbered excerpts retrieved from their catalog by semantic search.

Answer by calling the record_blog_answer tool. Rules:
- Ground the answer ONLY in the provided excerpts. Do not use outside knowledge or invent details the excerpts don't contain.
- Cite the excerpts you used by their [n] number in sources_used. Only list sources that genuinely informed the answer.
- The excerpts are ranked by relevance but some may be off-topic — ignore the ones that don't help.
- If the excerpts don't actually answer the question, say you couldn't find it in their catalog, set confidence to 'low', and leave sources_used empty.
- Write the answer in a direct, helpful voice ("You wrote about ...", "Your post on ... covers ..."). Do not write prose outside the tool — only call record_blog_answer.`;

// Answers a question grounded in retrieved content chunks. `chunks` is the
// ordered result of queryContentChunks ([{ contentId, title, text, ... }]); each
// becomes a numbered source the model may cite via sources_used (1-based,
// matching the order passed in). Returns { answer, sources_used, confidence }.
export async function answerBlogQuestion({ question, chunks }) {
  const sources = (chunks ?? [])
    .map((c, i) => {
      const title = c.title ? `"${c.title}"` : "(untitled)";
      return `[${i + 1}] ${title}\n${(c.text ?? "").trim()}`;
    })
    .join("\n\n");

  const userContent = [{
    text: `Question: ${question}\n\n=== SOURCE EXCERPTS (ranked by relevance) ===\n${sources}\n=== END EXCERPTS ===`,
  }];

  return invokeToolUse({
    system: BLOG_QA_SYSTEM_PROMPT,
    userContent,
    tool: RECORD_BLOG_ANSWER_TOOL,
    // Grounded synthesis: a little headroom for phrasing, but kept low so the
    // model stays close to the source text.
    temperature: 0.2,
    maxTokens: 1024,
  });
}

// Tool the model is forced to call when answering a question about the
// content catalog. Same shape as record_blog_answer: the grounded answer, the
// sources it actually used, and a self-assessed confidence, kept separate.
const RECORD_CONTENT_ANSWER_TOOL = {
  toolSpec: {
    name: "record_content_answer",
    description:
      "Record an answer to a question about the creator's content catalog, grounded only in the provided excerpts.",
    inputSchema: {
      json: {
        type: "object",
        required: ["answer", "sources_used", "confidence"],
        properties: {
          answer: {
            type: "string",
            description:
              "The answer, written for the creator, grounded ONLY in the provided source excerpts. If the excerpts don't contain the answer, say so plainly rather than guessing.",
          },
          sources_used: {
            type: "array",
            description:
              "The [n] source numbers whose excerpts the answer actually draws on. Empty when no source was relevant.",
            items: { type: "integer", minimum: 1 },
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
            description:
              "How well the excerpts support the answer: 'high' when they directly and fully answer it, 'low' when they barely touch it or don't.",
          },
        },
      },
    },
  },
};

const CONTENT_QA_SYSTEM_PROMPT = `You are a research assistant for a content creator, answering questions about THEIR OWN past content. You are given the question and a set of numbered excerpts retrieved from their catalog by semantic search.

Answer by calling the record_content_answer tool. Rules:
- Ground the answer ONLY in the provided excerpts. Do not use outside knowledge or invent details the excerpts don't contain.
- Cite the excerpts you used by their [n] number in sources_used. Only list sources that genuinely informed the answer.
- The excerpts are ranked by relevance but some may be off-topic — ignore the ones that don't help.
- If the excerpts don't actually answer the question, say you couldn't find it in their posts, set confidence to 'low', and leave sources_used empty.
- Write the answer in a direct, helpful voice ("You wrote about ...", "Your post on ... covers ..."). Do not write prose outside the tool — only call record_content_answer.`;

// Answers a question grounded in retrieved content chunks. `chunks` is the
// ordered result of queryContentChunks ([{ contentId, title, text, ... }]); each
// becomes a numbered source the model may cite via sources_used (1-based,
// matching the order passed in). Returns { answer, sources_used, confidence }.
export async function answerContentQuestion({ question, chunks }) {
  const sources = (chunks ?? [])
    .map((c, i) => {
      const title = c.title ? `"${c.title}"` : "(untitled)";
      return `[${i + 1}] ${title}\n${(c.text ?? "").trim()}`;
    })
    .join("\n\n");

  const userContent = [{
    text: `Question: ${question}\n\n=== SOURCE EXCERPTS (ranked by relevance) ===\n${sources}\n=== END EXCERPTS ===`,
  }];

  return invokeToolUse({
    system: CONTENT_QA_SYSTEM_PROMPT,
    userContent,
    tool: RECORD_CONTENT_ANSWER_TOOL,
    // Grounded synthesis: a little headroom for phrasing, but kept low so the
    // model stays close to the source text.
    temperature: 0.2,
    maxTokens: 1024,
  });
}

// ---------------------------------------------------------------------------
// Voice: learn a person's writing style and draft in it. The profile schema is
// shared by both tools so the shape compose reads is exactly the shape reflect
// writes — they can't drift.
// ---------------------------------------------------------------------------
const VOICE_PROFILE_SCHEMA = {
  type: "object",
  description: "Structured description of how this person writes on this platform.",
  properties: {
    portrait: {
      type: "string",
      description:
        "A plain-English portrait (2-4 sentences) of how this person writes on this platform, written in the second person ('You write...'). Describe their voice the way you'd explain it to a ghostwriter: the overall feel, what makes it recognizably theirs, and how it has been trending in the most recent posts. This is the human-readable summary of everything learned — make it vivid and specific, not a list of the fields below.",
    },
    tone: { type: "string", description: "Overall voice and attitude (e.g. wry, earnest, blunt, warm)." },
    audience: { type: "string", description: "Who they write for." },
    sentence_structure: { type: "string", description: "Typical sentence length, rhythm, and complexity." },
    vocabulary: { type: "string", description: "Characteristic word choices, jargon level, formality." },
    signature_phrases: {
      type: "array",
      description: "Recurring phrases, openers, or verbal tics that are distinctively theirs.",
      items: { type: "string" },
    },
    formatting_preferences: {
      type: "string",
      description: "Use of emoji, lists, headings, line breaks, length, hashtags, links, CTAs.",
    },
    dos: { type: "array", description: "Concrete things to do to sound like them.", items: { type: "string" } },
    donts: { type: "array", description: "Concrete things to avoid that would sound off-voice.", items: { type: "string" } },
  },
};

const RECORD_VOICE_POST_TOOL = {
  toolSpec: {
    name: "record_voice_post",
    description: "Record a drafted post written in the user's voice.",
    inputSchema: {
      json: {
        type: "object",
        required: ["post"],
        properties: {
          post: {
            type: "string",
            description: "The drafted post, ready to publish, in the user's voice and the requested platform's format.",
          },
          title: {
            type: "string",
            description: "A title/headline when the format calls for one (blog). Omit for short social posts.",
          },
        },
      },
    },
  },
};

const COMPOSE_SYSTEM_PROMPT = `You are a ghostwriter who writes in one specific person's voice. You are given (1) a structured style profile describing how they write on a platform, and (2) a few of their past posts as examples of that voice, each annotated with its publish date when known.

Write a NEW post on the requested topic for the requested platform that authentically matches their voice — tone, sentence structure, vocabulary, signature phrases, and formatting preferences. Their voice evolves over time: the examples are ordered by a blend of topical relevance and recency, and when examples conflict stylistically, favor the more recently published ones — they are the truest signal of how this person writes NOW. Match the requested format: 'social' = short, punchy, platform-native (no title); 'blog' = long-form structured prose with a title.

Emulate the style, do not copy the example posts' content. If the profile is empty, infer the voice from the examples. Output only by calling the record_voice_post tool.`;

// Renders the per-sample annotation for the compose/reflect prompts: publish
// date (the recency anchor) and, when present, the normalized weight share the
// recency model assigned the sample.
function voiceSampleLabel(sample) {
  const parts = [];
  if (typeof sample.publishedAt === "string" && sample.publishedAt.length > 0) {
    parts.push(`published ${sample.publishedAt.slice(0, 10)}`);
  }
  if (typeof sample.weightShare === "number") {
    parts.push(`recency weight ${Math.round(sample.weightShare * 100)}%`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

// Drafts a post in the user's voice. `profile` is the stored VoiceProfile.profile
// JSON (or null on cold start); `samples` are few-shot examples ([{ text,
// publishedAt? }] from queryVoiceSamples, pre-ranked by relevance + recency).
// Returns { post, title? }. Not persisted by this call.
export async function composeVoicePost({ topic, platform, format, profile, samples, guidance }) {
  const examples = (samples ?? []).filter((s) => s?.text);
  const exampleBlock = examples.length > 0
    ? examples.map((s, i) => `[${i + 1}]${voiceSampleLabel(s)} ${s.text}`).join("\n\n")
    : "(no examples yet)";

  const userContent = [{
    text: `=== STYLE PROFILE (${platform}) ===\n${
      profile ? JSON.stringify(profile, null, 2) : "(no learned profile yet — infer the voice from the examples below)"
    }\n\n=== PAST POSTS (ordered by relevance + recency; emulate, don't copy) ===\n${exampleBlock}\n\n=== TASK ===\nWrite a ${
      format === "blog" ? "long-form blog post" : "short social post"
    } for ${platform} about:\n${topic}${
      guidance ? `\n\nAdditional guidance: ${guidance}` : ""
    }\n\nCall record_voice_post with the result.`,
  }];

  return invokeToolUse({
    system: COMPOSE_SYSTEM_PROMPT,
    userContent,
    tool: RECORD_VOICE_POST_TOOL,
    // The most generative of the pipelines — give it room and warmth.
    temperature: 0.6,
    maxTokens: format === "blog" ? 3072 : 512,
  });
}

const RECORD_VOICE_PROFILE_TOOL = {
  toolSpec: {
    name: "record_voice_profile",
    description: "Record the updated structured writing-style profile for a platform.",
    inputSchema: {
      json: {
        type: "object",
        required: ["profile", "change_summary"],
        properties: {
          profile: VOICE_PROFILE_SCHEMA,
          change_summary: {
            type: "string",
            description: "One-paragraph summary of what changed versus the previous profile, and why.",
          },
        },
      },
    },
  },
};

const REFLECT_SYSTEM_PROMPT = `You maintain a structured profile of how a specific person writes on a given platform. You are given their current profile (which may be empty) and their recent posts, ordered newest-published first. Each post is annotated with its publish date and a recency weight — its share of influence on the profile, decaying exponentially with publish age.

Update the profile to reflect how they actually write NOW: infer tone, audience, sentence structure, vocabulary, signature phrases, formatting preferences, and concrete dos/donts directly from the samples, letting each sample's influence match its stated weight. When samples disagree — tone shifted, formatting habits changed, vocabulary moved on — the higher-weighted recent posts WIN; keep traits from older or lower-weighted posts only where nothing newer contradicts them. The profile should track the voice's evolution, not average over its whole history. Also write a vivid plain-English 'portrait' (2-4 sentences, second person) summarizing how they write now — this is the human-readable description a person reads to understand their own voice. Emit the FULL updated profile (a replacement, not a diff) plus a short change_summary describing what you changed versus the prior profile and any drift you observed toward the recent posts.

Be specific and grounded in the samples — do not invent traits the samples don't demonstrate. Output only by calling the record_voice_profile tool.`;

// Re-derives the style profile from recent samples. `currentProfile` is the
// prior VoiceProfile.profile JSON (or null); `samples` are recency-weighted
// VoiceSample rows ([{ text, publishedAt?, weightShare? }], newest-published
// first, from selectRecencyWeighted); `steering` is the creator's optional
// intent note. Returns { profile, change_summary }.
export async function reflectVoiceProfile({ platform, currentProfile, samples, steering }) {
  const recent = (samples ?? []).filter((s) => s?.text);
  const steeringBlock = typeof steering === "string" && steering.trim().length > 0
    ? `\n\n=== WHERE THEY'RE STEERING THEIR VOICE ===\nThe writer says they are currently aiming for: ${steering.trim()}\nHonor this direction where the recent samples are consistent with it or don't strongly contradict it; note in the change_summary how you applied it.`
    : "";
  const userContent = [{
    text: `=== CURRENT PROFILE (${platform}) ===\n${
      currentProfile ? JSON.stringify(currentProfile, null, 2) : "(none yet — build it from scratch)"
    }\n\n=== RECENT POSTS (newest-published first, recency-weighted) ===\n${
      recent.map((s, i) => `[${i + 1}]${voiceSampleLabel(s)} ${s.text}`).join("\n\n")
    }${steeringBlock}\n\nUpdate the profile by calling record_voice_profile.`,
  }];

  return invokeToolUse({
    system: REFLECT_SYSTEM_PROMPT,
    userContent,
    tool: RECORD_VOICE_PROFILE_TOOL,
    temperature: 0.3,
    maxTokens: 2048,
  });
}

const RECORD_VOICE_ASSESSMENT_TOOL = {
  toolSpec: {
    name: "record_voice_assessment",
    description: "Record a structured assessment of how well a draft matches the user's learned voice.",
    inputSchema: {
      json: {
        type: "object",
        required: ["score", "verdict", "summary"],
        properties: {
          score: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description: "How on-voice the draft is, 0 (nothing like them) to 100 (indistinguishable from their own writing).",
          },
          verdict: {
            type: "string",
            enum: ["on_voice", "close", "off_voice"],
            description: "'on_voice' (>=80), 'close' (50-79, needs small tweaks), 'off_voice' (<50, substantial rework).",
          },
          summary: {
            type: "string",
            description: "One-paragraph plain-English assessment of how well the draft sounds like them, written in the second person ('This reads like you, but...').",
          },
          strengths: {
            type: "array",
            description: "Specific things the draft gets right about their voice (tone, phrasing, structure).",
            items: { type: "string" },
          },
          issues: {
            type: "array",
            description: "Concrete places the draft drifts off-voice, strongest first.",
            items: {
              type: "object",
              required: ["detail", "suggestion"],
              properties: {
                area: {
                  type: "string",
                  description: "What aspect is off: tone, vocabulary, sentence-structure, formatting, signature-phrases, ...",
                },
                detail: { type: "string", description: "What's off-voice, quoting or referencing the draft." },
                suggestion: { type: "string", description: "How to bring it back into their voice." },
              },
            },
          },
          on_voice_rewrite: {
            type: "string",
            description: "Optional: a short revised version (or the opening) rewritten in their voice, when a concrete example would help. Omit for already on-voice drafts.",
          },
        },
      },
    },
  },
};

const ASSESS_SYSTEM_PROMPT = `You judge whether a draft sounds like one specific person, using their learned style profile and a few of their real past posts (annotated with publish dates) as the ground truth for their voice. Their voice is defined by how they write NOW — weight the more recently published examples most heavily when deciding what "on-voice" means.

Assess the draft against that voice and return your judgment by calling the record_voice_assessment tool: a 0-100 score, a verdict, a plain-English summary written to the person ("This reads like you, but the second paragraph is more formal than you usually get"), the specific strengths, and the concrete off-voice issues with fixes. Judge VOICE and STYLE — tone, rhythm, vocabulary, signature phrases, formatting habits — not the factual content or the topic. A draft on an unusual topic can still be perfectly on-voice. Be honest and specific; ground every point in the profile or the examples. Do not write prose outside the tool — only call record_voice_assessment.`;

// Assesses how well a draft matches the user's learned voice. `profile` is the
// stored VoiceProfile.profile JSON (or null); `samples` are recency-ranked
// examples ([{ text, publishedAt? }]); `draft` is the text to grade. Returns
// { score, verdict, summary, strengths?, issues?, on_voice_rewrite? }.
export async function assessVoiceMatch({ platform, profile, samples, draft }) {
  const examples = (samples ?? []).filter((s) => s?.text);
  const exampleBlock = examples.length > 0
    ? examples.map((s, i) => `[${i + 1}]${voiceSampleLabel(s)} ${s.text}`).join("\n\n")
    : "(no examples yet)";

  const userContent = [{
    text: `=== STYLE PROFILE (${platform}) ===\n${
      profile ? JSON.stringify(profile, null, 2) : "(no learned profile yet — judge from the examples below)"
    }\n\n=== THEIR PAST POSTS (ground truth for their voice; ordered by relevance + recency) ===\n${exampleBlock}\n\n=== DRAFT TO ASSESS ===\n${draft}\n=== END DRAFT ===\n\nAssess how on-voice the draft is by calling record_voice_assessment.`,
  }];

  return invokeToolUse({
    system: ASSESS_SYSTEM_PROMPT,
    userContent,
    tool: RECORD_VOICE_ASSESSMENT_TOOL,
    temperature: 0.2,
    maxTokens: 1536,
  });
}

// ---------------------------------------------------------------------------
// Content Radar: read what the creator's subscribed feeds are publishing right
// now and propose fresh content angles that follow THIS creator's voice and
// build on the topics they already cover. Grounds every angle in the actual
// feed items (cited by number) so ideas are anchored in the conversation
// happening now, not invented.
// ---------------------------------------------------------------------------
const RECORD_CONTENT_ANGLES_TOOL = {
  toolSpec: {
    name: "record_content_angles",
    description:
      "Record content angles and topic ideas derived from what the creator's subscribed feeds are currently publishing, tailored to the creator's voice.",
    inputSchema: {
      json: {
        type: "object",
        required: ["summary", "angles"],
        properties: {
          summary: {
            type: "string",
            description:
              "Two- to three-sentence read on what's being talked about across the feeds right now and where the strongest openings are for this creator.",
          },
          themes: {
            type: "array",
            description:
              "The distinct themes surfacing across the feed items right now, strongest first. A theme groups related stories; aim for 2-5.",
            items: {
              type: "object",
              required: ["theme"],
              properties: {
                theme: { type: "string", description: "Short name for the theme (a few words)." },
                momentum: {
                  type: "string",
                  enum: ["surging", "steady", "emerging", "fading"],
                  description: "How much energy this theme has across the feeds right now.",
                },
                why_it_fits: {
                  type: "string",
                  description:
                    "Why this theme is (or isn't) a natural fit for this creator, given their voice and the topics they already build on.",
                },
              },
            },
          },
          angles: {
            type: "array",
            description:
              "Concrete content ideas the creator could publish, strongest first. Aim for 4-8 high-quality angles, each a fresh take rather than a rehash of a feed item.",
            items: {
              type: "object",
              required: ["title", "angle", "rationale"],
              properties: {
                title: {
                  type: "string",
                  description: "A working headline for the piece, written the way this creator titles their work.",
                },
                angle: {
                  type: "string",
                  description:
                    "The specific take or argument — what the creator would say that the feeds aren't already saying, and why it's theirs to make.",
                },
                format: {
                  type: "string",
                  description:
                    "Suggested format/platform for this idea (e.g. blog, x thread, linkedin post, newsletter), matching where the creator publishes.",
                },
                rationale: {
                  type: "string",
                  description:
                    "Why this angle lands now: what in the feeds makes it timely and how it extends the creator's existing topics.",
                },
                on_voice_note: {
                  type: "string",
                  description:
                    "How to keep it on-voice — the tone, structure, or signature moves from this creator's style to apply.",
                },
                sources: {
                  type: "array",
                  description: "The [n] feed-item numbers this angle draws on. Empty when it's a net-new connection.",
                  items: { type: "integer", minimum: 1 },
                },
              },
            },
          },
        },
      },
    },
  },
};

const CONTENT_ANGLES_SYSTEM_PROMPT = `You are a content strategist for a specific solo creator. You are given (1) a snapshot of what the RSS/Atom feeds they follow are publishing right now, as a numbered list of items; (2) their learned writing voice — one or more plain-English voice "portraits" describing how they sound on each platform; and (3) the recent topics they've been building on (titles of their own recent work). Your job is to spot where the current conversation intersects with what this creator does, and propose content angles they could publish that authentically sound like them.

Return your ideas by calling the record_content_angles tool. Do all of the following:
- Read across the numbered feed items and identify the themes with real momentum right now. Don't just summarize individual items — cluster them.
- For each angle, give a working title in this creator's style, the specific take (what THEY would say that the feeds aren't already saying), a suggested format/platform they actually use, a rationale for why it's timely, and an on_voice_note on how to keep it sounding like them.
- Ground every angle in the feeds: cite the [n] item numbers each idea builds on. An angle may connect items no single feed connected — that's the most valuable kind — but it should still trace back to what's being discussed.

You may also be given the creator's stated preferences: topics they want to
lean INTO, topics/sources to AVOID, and who they're writing for (their
audience/goal). These are intent, and outrank the topics merely inferred from
their recent work — prioritize angles that serve the interests and audience, and
never propose an angle that centers on an avoided topic.

Rules:
- Follow the creator's voice and topics. An angle that's trending but nothing like what this creator makes is a weak angle; say so or leave it out. The best angles sit where the current conversation overlaps this creator's existing lane and stated interests.
- Honor the stated preferences: lean into the interests, respect the audience/goal, and skip anything on the avoid list (drop it rather than reshaping it).
- Propose fresh takes, not reposts. Never suggest simply resharing or summarizing a feed item.
- Favor quality over quantity — 4 to 8 strong, distinct angles beat a long generic list.
- If the voice portraits are absent, infer the creator's lane from their stated interests and recent topics and keep angles general. If the feeds are empty, say so in the summary and return no angles.
- Do not write prose outside the tool — only call record_content_angles.`;

// Proposes content angles from the live feed snapshot, grounded in the
// creator's voice, topics, and stated preferences. `items` is the aggregated
// feed items ([{ title, summary, link, feedTitle, publishedAt }], newest
// first); `voicePortraits` is [{ platform, portrait }] from the learned
// profiles; `recentTopics` is the creator's recent content titles (auto-derived
// lane); `interests` / `avoid` are the creator's stated topics to lean into /
// steer away from; `audience` is a who-they-write-for note; `platform`
// (optional) pins the target platform; `guidance` (optional) is free-text
// steering. Returns { summary, themes?, angles }.
export async function suggestContentAngles({ items, voicePortraits, recentTopics, interests, avoid, audience, platform, guidance }) {
  const contextBlock = formatContentAnglesContext({ items, voicePortraits, recentTopics, interests, avoid, audience, platform, guidance });
  const userContent = [{
    text: `Propose content angles from the current feed snapshot by calling the record_content_angles tool.\n\n${contextBlock}`,
  }];

  return invokeToolUse({
    system: CONTENT_ANGLES_SYSTEM_PROMPT,
    userContent,
    tool: RECORD_CONTENT_ANGLES_TOOL,
    // Ideation is generative — give it warmth and room, like the engagement
    // and compose pipelines.
    temperature: 0.6,
    maxTokens: 3072,
  });
}

// Renders the feed snapshot + creator context into the readable block the
// content-angles prompt reasons over. Feed items are numbered so the model can
// cite them by [n] in each angle's sources.
function formatContentAnglesContext({ items, voicePortraits, recentTopics, interests, avoid, audience, platform, guidance }) {
  const sections = [];

  const feedItems = Array.isArray(items) ? items : [];
  if (feedItems.length > 0) {
    const lines = feedItems.map((it, i) => {
      const parts = [`[${i + 1}] ${it.title ?? "(untitled)"}`];
      if (it.feedTitle) parts.push(`  source: ${it.feedTitle}`);
      if (it.publishedAt) parts.push(`  published: ${it.publishedAt.slice(0, 10)}`);
      if (it.summary) parts.push(`  ${it.summary}`);
      return parts.join("\n");
    });
    sections.push(`=== WHAT THE FEEDS ARE PUBLISHING NOW (numbered; cite by [n]) ===\n${lines.join("\n\n")}`);
  } else {
    sections.push("=== WHAT THE FEEDS ARE PUBLISHING NOW ===\n(no feed items available right now)");
  }

  const portraits = Array.isArray(voicePortraits) ? voicePortraits.filter((p) => p?.portrait) : [];
  if (portraits.length > 0) {
    const lines = portraits.map((p) => `- ${p.platform}: ${p.portrait}`);
    sections.push(`=== THE CREATOR'S VOICE (write angles that sound like this) ===\n${lines.join("\n")}`);
  } else {
    sections.push(
      "=== THE CREATOR'S VOICE ===\n(no learned voice yet — infer the creator's lane from their recent topics below)",
    );
  }

  const interestList = Array.isArray(interests) ? interests.filter((t) => typeof t === "string" && t.trim()) : [];
  if (interestList.length > 0) {
    sections.push(
      `=== TOPICS THE CREATOR WANTS TO LEAN INTO (stated intent — prioritize these) ===\n${interestList.map((t) => `- ${t}`).join("\n")}`,
    );
  }

  const avoidList = Array.isArray(avoid) ? avoid.filter((t) => typeof t === "string" && t.trim()) : [];
  if (avoidList.length > 0) {
    sections.push(
      `=== TOPICS/SOURCES TO AVOID (do not center an angle on these) ===\n${avoidList.map((t) => `- ${t}`).join("\n")}`,
    );
  }

  if (typeof audience === "string" && audience.trim().length > 0) {
    sections.push(`=== WHO THEY'RE WRITING FOR (audience/goal) ===\n${audience.trim()}`);
  }

  const topics = Array.isArray(recentTopics) ? recentTopics.filter((t) => typeof t === "string" && t.trim()) : [];
  if (topics.length > 0) {
    sections.push(`=== TOPICS THE CREATOR IS BUILDING ON (their recent work — inferred lane) ===\n${topics.map((t) => `- ${t}`).join("\n")}`);
  }

  if (platform) {
    sections.push(`=== TARGET PLATFORM ===\nFavor angles suited to: ${platform}`);
  }
  if (typeof guidance === "string" && guidance.length > 0) {
    sections.push(`=== USER GUIDANCE ===\n${guidance}`);
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
