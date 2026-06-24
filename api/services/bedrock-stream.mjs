import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { logger } from "./logger.mjs";
import { UpstreamError } from "./errors.mjs";

// Streaming counterparts to the forced-tool generators in bedrock.mjs. The
// non-streaming versions return structured JSON via a forced tool (great for
// the REST endpoints); these stream plain text token-by-token so the UI can
// type the draft/answer out live over a Lambda response stream. Plain text
// (no tool) is what makes incremental rendering clean — there's no partial
// JSON to parse.

const MODEL_ID = process.env.BEDROCK_MODEL_ID;
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";

const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

// Core streamer: yields text deltas from Converse. Errors (at start or
// mid-stream) become UpstreamError so callers handle them uniformly.
async function* streamConverseText({ system, userText, temperature = 0.5, maxTokens = 2048 }) {
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

const COMPOSE_STREAM_SYSTEM = `You are a ghostwriter who writes in one specific person's voice. You are given a structured style profile describing how they write, and a few of their past posts as examples.

Write a NEW post on the requested topic for the requested platform that authentically matches their voice — tone, sentence structure, vocabulary, signature phrases, and formatting. Match the format: 'social' = short, punchy, platform-native (no title); 'blog' = long-form markdown that starts with a single '# Title' line followed by the body.

Emulate the style, do not copy the example posts' content. Output ONLY the post itself — no preamble, no commentary, no surrounding quotes.`;

// Streams a composed post in the user's voice. Mirrors composeVoicePost's
// inputs; yields text deltas.
export function streamVoicePost({ topic, platform, format, profile, samples, guidance }) {
  const examples = (samples ?? []).filter((s) => s?.text);
  const exampleBlock = examples.length > 0
    ? examples.map((s, i) => `[${i + 1}] ${s.text}`).join("\n\n")
    : "(no examples yet)";

  const userText = `=== STYLE PROFILE (${platform}) ===\n${
    profile ? JSON.stringify(profile, null, 2) : "(no learned profile yet — infer the voice from the examples below)"
  }\n\n=== PAST POSTS (examples of their voice; emulate, don't copy) ===\n${exampleBlock}\n\n=== TASK ===\nWrite a ${
    format === "blog" ? "long-form blog post" : "short social post"
  } for ${platform} about:\n${topic}${guidance ? `\n\nAdditional guidance: ${guidance}` : ""}`;

  return streamConverseText({
    system: COMPOSE_STREAM_SYSTEM,
    userText,
    temperature: 0.6,
    maxTokens: format === "blog" ? 3072 : 512,
  });
}

const ASK_STREAM_SYSTEM = `You are a research assistant answering questions about a content creator's OWN past blog posts, using ONLY the provided excerpts. If the excerpts don't contain the answer, say you couldn't find it in their catalog rather than guessing. Write in a direct, helpful voice ("You wrote about ..."). Output ONLY the answer prose — no preamble.`;

// Streams a grounded answer over retrieved blog chunks. Mirrors
// answerBlogQuestion's inputs; yields text deltas. Citations are derived by the
// caller from the retrieved chunks (the stream carries only prose).
export function streamBlogAnswer({ question, chunks }) {
  const sources = (chunks ?? [])
    .map((c, i) => `[${i + 1}] ${c.title ? `"${c.title}"` : "(untitled)"}\n${(c.text ?? "").trim()}`)
    .join("\n\n");

  const userText = `Question: ${question}\n\n=== SOURCE EXCERPTS (ranked by relevance) ===\n${sources}\n=== END EXCERPTS ===`;

  return streamConverseText({
    system: ASK_STREAM_SYSTEM,
    userText,
    temperature: 0.2,
    maxTokens: 1024,
  });
}
