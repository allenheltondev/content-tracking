import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { logger } from "../logger.mjs";
import { UpstreamError } from "../errors.mjs";

// Shared Bedrock plumbing for the per-feature modules in this directory.
// Wraps the Converse API so feature code doesn't have to know about
// content-block shapes or tool-use plumbing. Prompt caching is on by
// default — the system prompts are large and identical across calls,
// which is exactly the workload prompt caching is for.

export const MODEL_ID = process.env.BEDROCK_MODEL_ID;
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";

const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

// Shared Converse plumbing: forces a single tool call, marks the system
// prompt cacheable, logs usage, and returns the tool input. The brief,
// draft-review, and engagement-recommendation pipelines all run through here.
export async function invokeToolUse({ system, userContent, tool, temperature = 0.1, maxTokens = 2048 }) {
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

// Streaming counterpart to the forced-tool generators. The non-streaming
// versions return structured JSON via a forced tool (great for the REST
// endpoints); this streams plain text token-by-token so the UI can type the
// draft/answer out live over a Lambda response stream. Plain text (no tool)
// is what makes incremental rendering clean — there's no partial JSON to
// parse.
//
// Core streamer: yields text deltas from Converse. Errors (at start or
// mid-stream) become UpstreamError so callers handle them uniformly.
export async function* streamConverseText({ system, userText, temperature = 0.5, maxTokens = 2048 }) {
  if (!MODEL_ID) throw new Error("BEDROCK_MODEL_ID env var is not set");

  let response;
  try {
    response = await bedrock.send(new ConverseStreamCommand({
      modelId: MODEL_ID,
      system: [{ text: system }],
      messages: [{ role: "user", content: [{ text: userText }] }],
      inferenceConfig: { maxTokens, temperature },
    }));
  } catch (err) {
    logger.error("Bedrock ConverseStream failed to start", { modelId: MODEL_ID, error: err?.message });
    throw new UpstreamError(`Bedrock stream failed: ${err?.message ?? "unknown"}`, 502);
  }

  try {
    for await (const event of response.stream ?? []) {
      const text = event.contentBlockDelta?.delta?.text;
      if (text) yield text;
    }
  } catch (err) {
    logger.error("Bedrock ConverseStream errored mid-stream", { modelId: MODEL_ID, error: err?.message });
    throw new UpstreamError(`Bedrock stream error: ${err?.message ?? "unknown"}`, 502);
  }
}
