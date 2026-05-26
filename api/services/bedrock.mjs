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
                  name_hint: {
                    type: "string",
                    description: "Vendor / brand name exactly as it appears in the brief.",
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

Be conservative. If a field is genuinely not stated in the brief, leave it off rather than guessing. Add a warning instead. Currency defaults to USD only when an amount is given without a currency. Do not write prose — only call the tool.`;

// Calls Bedrock Converse with the appropriate content for the source type.
// `pdfBytes` is a Buffer; pass it for PDF briefs. `text` is the chat
// transcript for chat briefs. Exactly one should be set.
export async function summarizeBrief({ sourceType, pdfBytes, text }) {
  if (!MODEL_ID) {
    throw new Error("BEDROCK_MODEL_ID env var is not set");
  }

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
      text: "Extract the structured summary from this brief by calling the record_brief_summary tool.",
    });
  } else if (sourceType === "chat") {
    if (!text) throw new Error("text is required for source_type=chat");
    userContent.push({
      text: `Extract the structured summary from the following chat transcript by calling the record_brief_summary tool.\n\n--- BEGIN TRANSCRIPT ---\n${text}\n--- END TRANSCRIPT ---`,
    });
  } else {
    throw new Error(`Unsupported source_type: ${sourceType}`);
  }

  const command = new ConverseCommand({
    modelId: MODEL_ID,
    system: [
      { text: SYSTEM_PROMPT },
      // Cache breakpoint at the end of the system prompt — every brief
      // call after the first within the cache window (~5 minutes) skips
      // the prefix recompute.
      { cachePoint: { type: "default" } },
    ],
    messages: [
      {
        role: "user",
        content: userContent,
      },
    ],
    toolConfig: {
      tools: [RECORD_BRIEF_TOOL],
      toolChoice: { tool: { name: "record_brief_summary" } },
    },
    inferenceConfig: {
      maxTokens: 2048,
      temperature: 0.1,
    },
  });

  let response;
  try {
    response = await bedrock.send(command);
  } catch (err) {
    logger.error("Bedrock Converse failed", {
      modelId: MODEL_ID,
      error: err?.message,
      name: err?.name,
    });
    throw new UpstreamError(`Bedrock call failed: ${err?.message ?? "unknown"}`, 502);
  }

  // Log cache stats for visibility when tuning the prompt.
  if (response.usage) {
    logger.info("Bedrock usage", {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadInputTokens: response.usage.cacheReadInputTokens,
      cacheWriteInputTokens: response.usage.cacheWriteInputTokens,
    });
  }

  const toolUse = extractToolUse(response);
  if (!toolUse) {
    const rawText = extractRawText(response);
    logger.error("Bedrock response had no tool_use block", {
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

function extractToolUse(response) {
  const content = response?.output?.message?.content ?? [];
  for (const block of content) {
    if (block.toolUse?.name === "record_brief_summary") {
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
