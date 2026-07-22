import { z } from "zod";
import { invokeToolUse, invokeStructured, MODEL_ID } from "./client.mjs";

// Brief pipeline: extract structured campaign metadata from an influencer
// marketing brief, and review a blog draft against the brief it was written
// for.

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

// record_draft_review: Record structured editorial feedback on a blog draft,
// assessed against its campaign brief. Same rationale as RECORD_BRIEF_TOOL:
// structured output beats parsing prose.
const DRAFT_REVIEW_SCHEMA = z.object({
  verdict: z
    .enum(["ready", "minor_revisions", "major_revisions"])
    .describe(
      "Overall readiness: 'ready' to publish, 'minor_revisions' for small fixes, 'major_revisions' for substantial work.",
    ),
  summary: z.string().describe("One-paragraph overall assessment of the draft."),
  brief_alignment: z
    .string()
    .optional()
    .describe(
      "How well the draft fulfills the brief's deliverables, required topics, tone, and must-mention features.",
    ),
  strengths: z.array(z.string()).optional().describe("Specific things the draft does well."),
  issues: z
    .array(
      z.object({
        severity: z.enum(["high", "medium", "low"]),
        area: z
          .string()
          .optional()
          .describe("What the issue is about: brief-coverage, structure, tone, accuracy, clarity, cta, seo, ..."),
        detail: z.string().describe("What's wrong, referencing the relevant part of the draft."),
        suggestion: z.string().optional().describe("How to fix it."),
      }),
    )
    .optional()
    .describe("Concrete, actionable problems to fix before publishing."),
  missing_requirements: z
    .array(z.string())
    .optional()
    .describe("Brief requirements (deliverables, must-mention features, CTAs) the draft does not address."),
});

const REVIEW_SYSTEM_PROMPT = `You are an experienced content editor reviewing a blog draft against the campaign brief it was written for. You are given the brief (summary, deliverables, target metrics, and any must-mention requirements) and the full draft text.

Review the draft and return your feedback as a structured result. Assess:

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
  const input = `Review the following blog draft against its campaign brief and return a structured result.\n\n=== CAMPAIGN BRIEF ===\n${briefBlock}\n\n=== DRAFT ===\n${draftText}\n=== END DRAFT ===`;

  return invokeStructured({
    system: REVIEW_SYSTEM_PROMPT,
    input,
    schema: DRAFT_REVIEW_SCHEMA,
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
