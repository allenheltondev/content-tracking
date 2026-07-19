import { z } from "zod";
import { runAgent } from "@readysetcloud/agent";
import { logger } from "./logger.mjs";

// The review "lenses": each is a specialized editorial pass over a piece of
// content that returns concrete, offset-anchored edit suggestions. They run on
// the rsc-core @readysetcloud/agent runtime via `runAgent` — a stateless,
// server-side, one-shot invocation that forces a Zod-validated result, bounds
// any tool loop, and threads trusted per-call context (tenantId) through
// `invocationState` so the model never supplies identity.
//
// The prompts here are the portable IP carried over from content-agent
// ("Betterer") — the scoring rubrics and red-flag taxonomies — re-expressed for
// this stack. Model choice is left to the package default (BEDROCK_MODEL_ID)
// unless a lens pins one; `runAgent` reads the same Bedrock env this stack
// already sets. The brand ("sounds like you") lens is grounded in Booked's own
// Voice profile + samples rather than a separate learned model.

// Each lens returns a list of these. The model provides the text to change and
// a rough location; the domain layer (recordSuggestions) re-derives the true
// offsets from `textToReplace`, so `startOffset`/`endOffset` are only hints.
// `type` is stamped by the lens itself (never trusted from the model), so it's
// not in the schema.
const suggestionItem = z.object({
  textToReplace: z
    .string()
    .min(1)
    .describe("The EXACT substring of the content to change, copied verbatim (case-sensitive)."),
  replaceWith: z.string().describe("The replacement text. Use an empty string to delete the span."),
  reason: z.string().describe("One sentence: why this change improves the content."),
  priority: z.enum(["low", "medium", "high"]),
  startOffset: z.number().int().optional().describe("Approximate start index of the span, if known."),
  endOffset: z.number().int().optional().describe("Approximate end index of the span, if known."),
});

const suggestionsOutput = z.object({
  suggestions: z
    .array(suggestionItem)
    .max(20)
    .describe("The specific, surgical edits this lens recommends. Quality over quantity."),
});

const summaryOutput = z.object({
  verdict: z
    .enum(["ready", "minor_revisions", "major_revisions"])
    .describe("Overall readiness: ready to publish, small fixes, or substantial work."),
  summary: z
    .string()
    .describe("A concise 2-3 sentence editorial summary: what works, what needs attention, what to prioritize."),
});

const READABILITY_PROMPT = `You are a grammar and readability editor. Review the content for clarity and flow, and suggest specific, surgical edits: break up run-on sentences, simplify needlessly complex words, convert passive voice to active, and trim wordiness. Do NOT rewrite wholesale or change the author's meaning or voice — every suggestion must target an exact span of the text and explain the improvement in one sentence. Skip nitpicks; prioritize changes that genuinely help a reader. If the writing is already clear, return few or no suggestions. Return your edits by producing the structured result.`;

const LLM_PROMPT = `You detect and remove "AI tells" — the telltale signs of generic, machine-sounding writing — so the author's real voice comes through. Flag and suggest surgical replacements for: template scaffolding and filler ("in today's fast-paced world", "it's important to note", "when it comes to"), overused LLM vocabulary ("delve", "leverage", "seamless", "ever-evolving landscape", "robust", "underscore"), em-dash overuse, hollow hedging, and vague claims stated without evidence. Each suggestion must target an exact span and offer a more specific, human replacement (or deletion). Do NOT flag domain terms that are genuinely apt, and do NOT strip personality — the goal is to make the writing sound more like a person, not more sterile. Return your edits as the structured result.`;

const BRAND_PROMPT = `You are the author's on-voice editor. Using their learned writing voice (profile and real past posts, provided below) as the ground truth for how they sound, flag places in this draft that drift OFF their voice and suggest surgical edits to bring them back on-voice. Judge tone, rhythm, vocabulary, signature phrasing, and formatting habits — NOT the topic or facts (an unusual topic can still be perfectly on-voice). Their voice is defined by how they write NOW, so weight the more recently published examples most heavily. Each suggestion must target an exact span and explain, in one sentence, how the edit sounds more like them. If the draft already sounds like them, return few or no suggestions. Return your edits as the structured result.`;

const SUMMARY_PROMPT = `You are the editor-in-chief summarizing a multi-lens review of a draft for its author. You are given the draft and the concrete suggestions the review lenses produced. Write a short, honest editorial summary (2-3 sentences): what the draft does well, what most needs attention, and what to prioritize — then choose a verdict. Be specific and encouraging without inflating: 'ready' only if you'd publish as-is, 'minor_revisions' for small polish, 'major_revisions' when it needs real work. Return the structured result.`;

// Stamps the lens's suggestion type onto each item (the model never classifies
// its own type). Returns [] defensively when a lens produced nothing.
function withType(suggestions, type) {
  return (suggestions ?? []).map((s) => ({ ...s, type }));
}

// Shared runner: one structured, tool-free analysis over `body`. Kept small so
// each lens is just a prompt + a type. `temperature` stays low — these are
// analytical passes, not generative ones.
async function runContentLens({ body, tenantId, systemPrompt, type, temperature = 0.2, modelId }) {
  const { output } = await runAgent({
    input: body,
    systemPrompt,
    outputSchema: suggestionsOutput,
    temperature,
    maxTokens: 2048,
    modelId,
    invocationState: { tenantId },
  });
  return withType(output.suggestions, type);
}

export async function runReadabilityLens({ body, tenantId, modelId }) {
  return runContentLens({ body, tenantId, systemPrompt: READABILITY_PROMPT, type: "grammar", modelId });
}

export async function runLlmLens({ body, tenantId, modelId }) {
  return runContentLens({ body, tenantId, systemPrompt: LLM_PROMPT, type: "llm", modelId });
}

// The on-voice lens, grounded in Booked's Voice feature (learned profile +
// recency-ranked real samples) rather than a separate model. The caller
// gathers the Voice context (it owns the embedding + retrieval); this shapes
// the grounded prompt and runs the lens.
export async function runBrandLens({ body, tenantId, platform, profile, samples, modelId }) {
  const grounding = buildVoiceGrounding(platform, profile, samples);
  const { output } = await runAgent({
    input: body,
    systemPrompt: `${BRAND_PROMPT}\n\n${grounding}`,
    outputSchema: suggestionsOutput,
    temperature: 0.3,
    maxTokens: 2048,
    modelId,
    invocationState: { tenantId },
  });
  return withType(output.suggestions, "brand");
}

// Synthesizes the lens findings into an editorial summary + verdict. `findings`
// is the list of recorded suggestions (each with type/reason); the summary
// reasons over them plus the draft.
export async function runSummaryLens({ body, findings, tenantId, modelId }) {
  const input = `=== DRAFT ===\n${body}\n\n=== REVIEW FINDINGS (${findings.length}) ===\n${formatFindings(findings)}`;
  const { output } = await runAgent({
    input,
    systemPrompt: SUMMARY_PROMPT,
    outputSchema: summaryOutput,
    temperature: 0.3,
    maxTokens: 1024,
    modelId,
    invocationState: { tenantId },
  });
  return output;
}

// Renders the learned voice (portrait/profile + dated example posts) into the
// grounding block the brand lens reasons against. Mirrors how the Voice compose
// / check prompts present the profile + samples.
function buildVoiceGrounding(platform, profile, samples) {
  const profileBlock = profile
    ? JSON.stringify(profile, null, 2)
    : "(no learned profile yet — infer the voice from the examples)";
  const examples = (samples ?? []).filter((s) => s?.text);
  const exampleBlock = examples.length > 0
    ? examples
        .map((s, i) => {
          const when = typeof s.publishedAt === "string" ? ` (published ${s.publishedAt.slice(0, 10)})` : "";
          return `[${i + 1}]${when} ${s.text}`;
        })
        .join("\n\n")
    : "(no example posts yet)";
  return `=== THE AUTHOR'S LEARNED VOICE${platform ? ` (${platform})` : ""} ===\n${profileBlock}\n\n=== THEIR PAST POSTS (ground truth; recent examples weigh most) ===\n${exampleBlock}`;
}

function formatFindings(findings) {
  if (!findings || findings.length === 0) return "(no specific suggestions were produced)";
  const byType = {};
  for (const f of findings) {
    (byType[f.type] ??= []).push(f.reason);
  }
  return Object.entries(byType)
    .map(([type, reasons]) => `${type} (${reasons.length}): ${reasons.slice(0, 5).join("; ")}`)
    .join("\n");
}

// Runs a lens with per-lens error isolation for the orchestrator: a lens that
// throws is logged and contributes no suggestions rather than failing the whole
// review. Returns { type, suggestions, ok }.
export async function runLensSafely(name, fn) {
  try {
    const suggestions = await fn();
    return { name, suggestions: suggestions ?? [], ok: true };
  } catch (err) {
    logger.warn("Review lens failed (non-fatal)", { lens: name, error: err?.message });
    return { name, suggestions: [], ok: false };
  }
}
