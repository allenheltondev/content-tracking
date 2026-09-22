import { z } from "zod";
import { runAgent, httpRequest } from "@readysetcloud/agent";
import { logger } from "./logger.mjs";
import { renderSignatureHabits } from "./voice-signature.mjs";

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
  reason: z
    .string()
    .describe(
      "One sentence naming the concrete problem a reader would hit. 'More concise', 'more professional', 'more formal', 'better flow' and 'improves clarity' are not problems — if that is the whole reason, do not emit the suggestion.",
    ),
  priority: z
    .enum(["low", "medium", "high"])
    .describe(
      "high: a reader is actually misled or blocked. medium: a real problem worth fixing. low: worth mentioning but the author can ignore it.",
    ),
  startOffset: z.number().int().optional().describe("Approximate start index of the span, if known."),
  endOffset: z.number().int().optional().describe("Approximate end index of the span, if known."),
});

// The per-lens suggestion cap. Deliberately small: at 20 the lenses reliably
// returned 20, and a list that long is only reachable by padding it with
// style-consistency nits the author never asked about. A tight cap forces the
// model to spend its slots on the edits that actually matter, and it keeps the
// structured response inside MAX_OUTPUT_TOKENS on a long post.
const MAX_SUGGESTIONS = 8;

const suggestionsOutput = z.object({
  suggestions: z
    .array(suggestionItem)
    .max(MAX_SUGGESTIONS)
    // Just the cap. The lens prompts already say when to stay quiet, and
    // repeating "fewer is better" here stacked suppression on suppression:
    // every lens went silent on drafts that did have small, real problems.
    .describe(`The edits this lens recommends, at most ${MAX_SUGGESTIONS}.`),
});

// Output headroom for one lens. 2048 was not enough for a structured response
// over a ~2000-word post: the model ran out mid-tool-call and the whole lens
// failed with MaxTokensError, which the orchestrator then swallowed as "this
// lens found nothing". The cap only bounds a runaway, so it can afford to be
// generous.
const MAX_OUTPUT_TOKENS = 8192;

// The model the review lenses run on. Editorial judgment is the hardest thing
// this stack asks a model to do — it has to tell a deliberate stylistic choice
// from a mistake — and the default chat model (BEDROCK_MODEL_ID, tuned for
// /briefs) is not up to it: it both failed to emit valid structured output on
// longer posts and defaulted to formalizing everything it touched. Reviews pin
// their own model so that choice is independent of the rest of the stack.
function reviewModelId(explicit) {
  return explicit ?? process.env.REVIEW_MODEL_ID ?? undefined;
}

const summaryOutput = z.object({
  verdict: z
    .enum(["ready", "minor_revisions", "major_revisions"])
    .describe("Overall readiness: ready to publish, small fixes, or substantial work."),
  summary: z
    .string()
    .describe("A concise 2-3 sentence editorial summary: what works, what needs attention, what to prioritize."),
});

const READABILITY_PROMPT = `You are a grammar and readability editor. Review the content for clarity and flow, and suggest specific, surgical edits: fix grammar errors, break up sentences a reader genuinely loses the thread of, replace words that obscure meaning, and cut filler that carries nothing.

You are correcting mistakes, not enforcing a house style. Never suggest an edit whose only justification is that the result would be shorter, plainer, more formal, more conventional, or more "professional" than what the author wrote. A long sentence that reads fine is fine. An informal word the author chose on purpose is fine. Passive voice used deliberately is fine. If your one-sentence reason amounts to "this is how editors usually prefer it", do not emit the suggestion.

Every suggestion must target an exact span of the text and explain, in one sentence, the concrete problem a reader would hit. Skip nitpicks. If the writing is already clear, return few or no suggestions — an empty list is a valid and common result. Return your edits by producing the structured result.`;

const LLM_PROMPT = `You detect and remove "AI tells" — the signs that a passage was generated rather than written — so the author's real voice comes through. Candidates include template scaffolding and filler ("in today's fast-paced world", "it's important to note", "when it comes to"), overused LLM vocabulary ("delve", "leverage", "seamless", "ever-evolving landscape", "robust", "underscore"), hollow hedging, and confident claims with nothing behind them.

That list is generic, and it is a starting point rather than a verdict. Many of its entries — dashes, direct address, asides, informal openers, rhetorical questions — are also how ordinary people write. When the author's established voice is given below, check every candidate against it FIRST: a trait that runs through their published writing is their voice, and flagging it is the error this lens exists to avoid. Flag such a trait only where a single instance is clearly beyond how they normally use it, and say that in the reason.

Never flag a passage for being casual, opinionated, funny, or personal. Those are the marks of a human writing, which is what you are here to protect. Do NOT flag domain terms that are genuinely apt.

Each suggestion must target an exact span and offer a more specific, human replacement (or deletion). Returning few or no suggestions is the correct outcome for writing that already sounds like a person. Return your edits as the structured result.`;

const BRAND_PROMPT = `You are the author's on-voice editor. Using their learned writing voice (profile and real past posts, provided below) as the ground truth for how they sound, flag places in this draft that drift OFF their voice and suggest surgical edits to bring them back on-voice. Judge tone, rhythm, vocabulary, signature phrasing, and formatting habits — NOT the topic or facts (an unusual topic can still be perfectly on-voice). Their voice is defined by how they write NOW, so weight the more recently published examples most heavily.

Direction matters, and it only runs one way. This author wrote this draft, so the default assumption is that it already sounds like them. You are looking for the passages that sound like SOMEONE ELSE wrote them — flat corporate register, generic thought-leader phrasing, the tone of a press release. An edit that makes the draft more formal, more authoritative, more polished, or less personal than what the author wrote is drift, not a correction, and you must not propose it. If you find yourself replacing a joke, an aside, a contraction, or a plain word with something more impressive, stop: you are editing them out of their own post.

Each suggestion must target an exact span and explain, in one sentence, how the edit sounds more like them. If the draft already sounds like them, return few or no suggestions. Return your edits as the structured result.`;

const FACT_PROMPT = `You are a fact-checker for a content creator. Identify the specific, verifiable claims in the draft — statistics, dates, named events, quantities, attributions — and check them. Use the http_request tool to search the web for authoritative sources, then judge each claim. For each claim that is INCORRECT or that you could not verify, emit a suggestion that replaces the claim's exact text with a corrected or appropriately hedged version, and say what you found (and ideally the source) in the reason. Do NOT flag opinions, predictions, or matters of style — only checkable facts. If a claim checks out, leave it alone. Be economical: a few targeted searches, not an exhaustive audit. Return the structured result.`;

// The voice guard's output: which candidate edits to throw away. It returns
// indexes into the numbered list it was given rather than echoing the edits
// back, so a model that paraphrases can't quietly rewrite a suggestion on its
// way through, and an out-of-range index is simply dropped by the caller.
const guardOutput = z.object({
  drop: z
    .array(
      z.object({
        index: z.number().int().describe("The 1-based number of the edit to discard, exactly as listed."),
        reason: z.string().describe("One sentence: which part of the author's voice this edit would have flattened."),
      }),
    )
    .describe("The edits to discard. Return an empty array when every edit is fair."),
});

const GUARD_PROMPT = `You are the author's voice guard, and the last check before edits reach them.

You are given their draft, their established voice, and a numbered list of edits that the review's editing passes want to make. Those passes optimize for prose that is shorter, flatter, and more conventional, which is how a distinctive writer's personality gets edited out one reasonable-looking suggestion at a time. Judge every edit on the list the same way, including the ones that claim to be making the draft sound more like the author — a pass can flatten someone while citing their own voice as the reason.

Your only job is to discard the edits that would make the draft sound less like them. Discard an edit when it removes a signature habit or phrase, neutralizes humor, opinion, or an aside, replaces the author's word with a blander one, formalizes a deliberately casual passage, or is justified only by a generic style rule rather than by a problem a reader would actually hit.

Keep an edit when it fixes something genuinely wrong no matter whose writing it is: a typo or grammar error, a sentence that does not parse, a factual mistake, a passage a reader would truly misread, or filler this author would not have written.

When an edit is defensible on its own terms but you would not miss it, discard it. Suggestions are cheap to lose and voice is expensive to get back. Do not discard the whole list reflexively either: an empty result is correct when the edits are all fair. Judge each one against the voice you were given, not against your own taste. Return the structured result.`;

const SUMMARY_PROMPT = `You are the editor-in-chief summarizing a multi-lens review of a draft for its author. You are given the draft and the concrete suggestions the review lenses produced. Write a short, honest editorial summary (2-3 sentences): what the draft does well, what most needs attention, and what to prioritize — then choose a verdict. Be specific and encouraging without inflating: 'ready' only if you'd publish as-is, 'minor_revisions' for small polish, 'major_revisions' when it needs real work.

You may be told that some passes of the review did not finish. If so, you are summarizing an INCOMPLETE review and you must not present it as a clean bill of health: say plainly in the summary which kind of feedback is missing and that the draft has not been fully checked. Never return 'ready' in that case — a pass that didn't run cannot have found nothing, and the absence of suggestions from it is missing information, not a pass. Choose 'minor_revisions' or 'major_revisions' based on what the passes that DID run found.

Return the structured result.`;

// Stamps the lens's suggestion type onto each item (the model never classifies
// its own type). Returns [] defensively when a lens produced nothing.
function withType(suggestions, type) {
  return (suggestions ?? []).map((s) => ({ ...s, type }));
}

// Shared runner: one structured, tool-free analysis over `body`. Kept small so
// each lens is just a prompt + a type. `temperature` stays low — these are
// analytical passes, not generative ones. `voice` is the optional grounding
// (profile + measured signature); when the tenant has one it is appended as a
// hands-off constraint, and when they don't the lens runs as it always did.
async function runContentLens({ body, tenantId, systemPrompt, type, temperature = 0.2, modelId, voice }) {
  const constraint = buildVoiceConstraint(voice);
  const { output } = await runAgent({
    input: body,
    systemPrompt: constraint ? `${systemPrompt}\n\n${constraint}` : systemPrompt,
    outputSchema: suggestionsOutput,
    temperature,
    maxTokens: MAX_OUTPUT_TOKENS,
    modelId: reviewModelId(modelId),
    invocationState: { tenantId },
  });
  return withType(output.suggestions, type);
}

export async function runReadabilityLens({ body, tenantId, modelId, voice }) {
  return runContentLens({ body, tenantId, systemPrompt: READABILITY_PROMPT, type: "grammar", modelId, voice });
}

export async function runLlmLens({ body, tenantId, modelId, voice }) {
  return runContentLens({ body, tenantId, systemPrompt: LLM_PROMPT, type: "llm", modelId, voice });
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
    maxTokens: MAX_OUTPUT_TOKENS,
    modelId: reviewModelId(modelId),
    invocationState: { tenantId },
  });
  return withType(output.suggestions, "brand");
}

// The fact-checker lens. Unlike the other lenses this one has a tool loop: it
// drives the vended `http_request` tool (from @readysetcloud/agent) to search
// the web and verify claims, bounded by maxIterations so a runaway search can't
// hang the review. `search` describes the endpoint + auth the prompt tells the
// model to call; the caller only runs this lens when a search provider is
// configured. The search key rides in the prompt-supplied header per the
// package's documented http_request usage.
export async function runFactLens({ body, tenantId, search, modelId }) {
  const authLine = search?.authHeader
    ? ` Include the request header "${search.authHeader.name}: ${search.authHeader.value}".`
    : '';
  const systemPrompt = `${FACT_PROMPT}

To verify a claim, call the http_request tool with a GET request to this search endpoint, putting your query in the request:
  ${search.url}
${authLine} Read the JSON results and judge the claim against what authoritative sources say.`;

  const { output } = await runAgent({
    input: body,
    systemPrompt,
    outputSchema: suggestionsOutput,
    tools: [httpRequest],
    maxIterations: 8,
    temperature: 0.2,
    maxTokens: MAX_OUTPUT_TOKENS,
    modelId: reviewModelId(modelId),
    invocationState: { tenantId },
  });
  return withType(output.suggestions, 'fact');
}

// The voice guard: an arbitration pass over what the voice-blind lenses want to
// do. Without it the lens outputs are simply concatenated, which means the brand
// lens can only ADD "sound more like you" edits and can never veto a readability
// edit that flattens a signature phrase. Worse, the brand lens is told to stay
// quiet when a draft already sounds like its author — which a draft they wrote
// usually does — so the healthier the voice, the more completely the review is
// dominated by lenses that don't know what that voice is. This pass closes that
// gap: it runs after fan-out, sees the candidate edits together, and throws out
// the ones that would cost the author more voice than they buy in polish.
//
// `candidates` are the suggestions to judge (the caller decides which types are
// in scope — factual corrections and the brand lens's own output are not).
// Returns the 0-based positions in `candidates` to discard, filtered to the
// indexes the model was actually offered.
export async function runVoiceGuard({ body, candidates, tenantId, platform, profile, samples, signature, modelId }) {
  const list = candidates ?? [];
  if (list.length === 0) return [];

  const grounding = buildVoiceGrounding(platform, profile, samples);
  const habits = renderSignatureHabits(signature);
  const numbered = list
    .map((c, i) => `[${i + 1}] (${c.type}) replace "${c.textToReplace}" with "${c.replaceWith ?? ""}"\n     stated reason: ${c.reason}`)
    .join("\n");

  const { output } = await runAgent({
    input: `=== DRAFT ===\n${body}\n\n=== PROPOSED EDITS (${list.length}) ===\n${numbered}`,
    systemPrompt: `${GUARD_PROMPT}\n\n${grounding}${habits ? `\n\n${habits}` : ""}`,
    outputSchema: guardOutput,
    temperature: 0.2,
    maxTokens: MAX_OUTPUT_TOKENS,
    modelId: reviewModelId(modelId),
    invocationState: { tenantId },
  });

  const dropped = new Set();
  for (const item of output.drop ?? []) {
    const index = item.index - 1;
    if (Number.isInteger(index) && index >= 0 && index < list.length) dropped.add(index);
  }
  return [...dropped];
}

// Synthesizes the lens findings into an editorial summary + verdict. `findings`
// is the list of recorded suggestions (each with type/reason); the summary
// reasons over them plus the draft.
export async function runSummaryLens({ body, findings, tenantId, modelId, failed }) {
  // A pass that threw contributes no findings, which is indistinguishable from
  // a pass that ran and found nothing unless we say so. Without this the
  // editor-in-chief can hand back "ready" on a draft half of the review never
  // looked at.
  const incomplete = (failed ?? []).length > 0
    ? `\n\n=== PASSES THAT DID NOT FINISH ===\n${failed.map((f) => `- ${describePass(f)}`).join("\n")}\nThis review is incomplete. Say so, and do not return 'ready'.`
    : "";
  const input = `=== DRAFT ===\n${body}\n\n=== REVIEW FINDINGS (${findings.length}) ===\n${formatFindings(findings)}${incomplete}`;
  const { output } = await runAgent({
    input,
    systemPrompt: SUMMARY_PROMPT,
    outputSchema: summaryOutput,
    temperature: 0.3,
    maxTokens: 1024,
    modelId: reviewModelId(modelId),
    invocationState: { tenantId },
  });
  return output;
}

// Fields of the learned profile that a review lens must never see.
//
// These are the fields the reflection model fills with editorial advice rather
// than description. A real profile came back with donts: ["Avoid overly casual
// language."], tone: "authoritative", sentence_structure: "Clear and concise
// sentences with a focus on delivering information efficiently" — a generic
// tech-blogger archetype rather than the person. Handed to the lenses as "how
// this author sounds", it read as a standing instruction to formalize, and the
// lenses obeyed: they rewrote "I have bad news" into "Here's a critical
// insight:", and cited "to avoid overly casual language" — the profile's own
// words — as the reason. The lens whose job is removing AI tells was adding
// them.
//
// Compose still gets the whole profile; it is writing new prose and a target
// tone is useful there. Review is the opposite job — it decides what to leave
// alone — so it sees only the fields that describe what the author actually
// does. `reflectVoiceProfile` has since been taught to write these fields
// descriptively, but a lens must not be one bad reflection away from
// flattening someone, so the projection stays regardless.
const PRESCRIPTIVE_PROFILE_FIELDS = ["donts", "tone", "sentence_structure"];

// Projects a learned profile down to what a review lens is allowed to reason
// against. Returns null unchanged so callers keep their cold-start path.
export function describedVoiceOnly(profile) {
  if (!profile || typeof profile !== "object") return profile ?? null;
  const kept = Object.fromEntries(
    Object.entries(profile).filter(([key]) => !PRESCRIPTIVE_PROFILE_FIELDS.includes(key)),
  );
  return Object.keys(kept).length > 0 ? kept : null;
}

// Renders the learned voice (portrait/profile + dated example posts) into the
// grounding block the brand lens reasons against. Mirrors how the Voice compose
// / check prompts present the profile + samples.
function buildVoiceGrounding(platform, profile, samples) {
  const described = describedVoiceOnly(profile);
  const profileBlock = described
    ? JSON.stringify(described, null, 2)
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

// Renders the hands-off constraint the voice-blind style lenses get. This is
// deliberately NOT the brand lens's grounding: it carries the learned profile's
// descriptive parts plus the measured habits, and no full sample posts. Those
// lenses don't need examples to imitate — they need to know which traits are the
// author's on purpose so they stop proposing edits that erase them. Returns ""
// when there is nothing grounded to say, so the lens runs unchanged.
function buildVoiceConstraint(voice) {
  if (!voice) return "";
  const { platform, signature } = voice;
  const profile = describedVoiceOnly(voice.profile);

  const parts = [];
  const portrait = typeof profile?.portrait === "string" ? profile.portrait.trim() : "";
  if (portrait) parts.push(portrait);

  const phrases = (profile?.signature_phrases ?? []).filter((p) => typeof p === "string" && p.trim());
  if (phrases.length > 0) parts.push(`Phrasing that is distinctively theirs: ${phrases.join("; ")}.`);

  const dos = (profile?.dos ?? []).filter((d) => typeof d === "string" && d.trim());
  if (dos.length > 0) parts.push(`Things they do on purpose: ${dos.join("; ")}.`);

  const habits = renderSignatureHabits(signature);
  if (parts.length === 0 && !habits) return "";

  const described = parts.length > 0
    ? `=== THE AUTHOR'S ESTABLISHED VOICE${platform ? ` (${platform})` : ""} ===\n${parts.join("\n\n")}`
    : "";

  return [described, habits].filter(Boolean).join("\n\n");
}

// What a pass actually checks, so the summary can name the missing feedback
// rather than an internal lens key. Unknown names pass through as themselves.
const PASS_DESCRIPTIONS = {
  readability: "readability — grammar and clarity errors were not checked",
  llm: "AI tells — generated-sounding phrasing was not checked",
  brand: "on-voice — nothing checked whether the draft sounds like the author",
  fact: "fact-checking — the draft's verifiable claims were not checked",
  "voice-guard": "the voice guard — every suggestion below is unarbitrated, and some may flatten the author's voice",
};

function describePass(name) {
  return PASS_DESCRIPTIONS[name] ?? name;
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
