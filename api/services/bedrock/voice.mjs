import { z } from "zod";
import { invokeStructured, streamConverseText } from "./client.mjs";

// ---------------------------------------------------------------------------
// Voice: learn a person's writing style and draft in it. The profile schema is
// shared by both pipelines so the shape compose reads is exactly the shape
// reflect writes — they can't drift.
// ---------------------------------------------------------------------------
const VOICE_PROFILE_SCHEMA = z
  .object({
    portrait: z
      .string()
      .optional()
      .describe(
        "A plain-English portrait (2-4 sentences) of how this person writes on this platform, written in the second person ('You write...'). Describe their voice the way you'd explain it to a ghostwriter: the overall feel, what makes it recognizably theirs, and how it has been trending in the most recent posts. This is the human-readable summary of everything learned — make it vivid and specific, not a list of the fields below.",
      ),
    tone: z
      .string()
      .optional()
      .describe(
        "Overall voice and attitude as it actually reads (e.g. wry, earnest, blunt, warm, self-deprecating). Describe this person, not the genre they write in — 'authoritative and informative' is true of every tech blog and tells a reader nothing about them.",
      ),
    audience: z.string().optional().describe("Who they write for."),
    sentence_structure: z
      .string()
      .optional()
      .describe(
        "Typical sentence length, rhythm, and complexity, reported from the samples. Say what they do (e.g. 'long winding sentences broken by three-word fragments'), not what good prose should do — do not write 'clear and concise' unless the samples are genuinely clipped.",
      ),
    vocabulary: z.string().optional().describe("Characteristic word choices, jargon level, formality."),
    signature_phrases: z
      .array(z.string())
      .optional()
      .describe("Recurring phrases, openers, or verbal tics that are distinctively theirs."),
    formatting_preferences: z
      .string()
      .optional()
      .describe("Use of emoji, lists, headings, line breaks, length, hashtags, links, CTAs."),
    dos: z
      .array(z.string())
      .optional()
      .describe(
        "Concrete things to do to sound like them, each one a habit you can point to in the samples (e.g. 'open with a story from your own week', 'end sections on a one-line verdict').",
      ),
    donts: z
      .array(z.string())
      .optional()
      .describe(
        "Concrete things that would make a draft stop sounding like THIS person — each must be something the samples show they never do. This is not a place for general writing advice: 'avoid overly casual language', 'avoid jargon without explanation' and 'avoid long sentences' are rules about good prose, not facts about them, and an entry like that is worse than no entry because it gets read back as an instruction to flatten their voice. If the samples ARE casual, then being stiff and formal is the dont. Return an empty list rather than inventing one.",
      ),
  })
  .describe("Structured description of how this person writes on this platform.");

// record_voice_post: Record a drafted post written in the user's voice.
const VOICE_POST_SCHEMA = z.object({
  post: z
    .string()
    .describe("The drafted post, ready to publish, in the user's voice and the requested platform's format."),
  title: z
    .string()
    .optional()
    .describe("A title/headline when the format calls for one (blog). Omit for short social posts."),
});

const COMPOSE_SYSTEM_PROMPT = `You are a ghostwriter who writes in one specific person's voice. You are given (1) a structured style profile describing how they write on a platform, and (2) a few of their past posts as examples of that voice, each annotated with its publish date when known.

Write a NEW post on the requested topic for the requested platform that authentically matches their voice — tone, sentence structure, vocabulary, signature phrases, and formatting preferences. Their voice evolves over time: the examples are ordered by a blend of topical relevance and recency, and when examples conflict stylistically, favor the more recently published ones — they are the truest signal of how this person writes NOW. Match the requested format: 'social' = short, punchy, platform-native (no title); 'blog' = long-form structured prose with a title.

Emulate the style, do not copy the example posts' content. If the profile is empty, infer the voice from the examples. Output only the structured result.`;

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

// Token budget for a composed draft: long-form blog posts get real headroom,
// short social posts stay capped. Shared by the structured and streaming
// compose paths so they can't drift.
function composeMaxTokens(format) {
  return format === "blog" ? 3072 : 512;
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

  const input = `=== STYLE PROFILE (${platform}) ===\n${
    profile ? JSON.stringify(profile, null, 2) : "(no learned profile yet — infer the voice from the examples below)"
  }\n\n=== PAST POSTS (ordered by relevance + recency; emulate, don't copy) ===\n${exampleBlock}\n\n=== TASK ===\nWrite a ${
    format === "blog" ? "long-form blog post" : "short social post"
  } for ${platform} about:\n${topic}${
    guidance ? `\n\nAdditional guidance: ${guidance}` : ""
  }\n\nReturn the structured result.`;

  return invokeStructured({
    system: COMPOSE_SYSTEM_PROMPT,
    input,
    schema: VOICE_POST_SCHEMA,
    // The most generative of the pipelines — give it room and warmth.
    temperature: 0.6,
    maxTokens: composeMaxTokens(format),
  });
}

// record_voice_profile: Record the updated structured writing-style profile
// for a platform.
const VOICE_PROFILE_UPDATE_SCHEMA = z.object({
  profile: VOICE_PROFILE_SCHEMA,
  change_summary: z
    .string()
    .describe("One-paragraph summary of what changed versus the previous profile, and why."),
});

const REFLECT_SYSTEM_PROMPT = `You maintain a structured profile of how a specific person writes on a given platform. You are given their current profile (which may be empty) and their recent posts, ordered newest-published first. Each post is annotated with its publish date and a recency weight — its share of influence on the profile, decaying exponentially with publish age.

Update the profile to reflect how they actually write NOW: infer tone, audience, sentence structure, vocabulary, signature phrases, formatting preferences, and concrete dos/donts directly from the samples, letting each sample's influence match its stated weight. When samples disagree — tone shifted, formatting habits changed, vocabulary moved on — the higher-weighted recent posts WIN; keep traits from older or lower-weighted posts only where nothing newer contradicts them. The profile should track the voice's evolution, not average over its whole history. Also write a vivid plain-English 'portrait' (2-4 sentences, second person) summarizing how they write now — this is the human-readable description a person reads to understand their own voice. Emit the FULL updated profile (a replacement, not a diff) plus a short change_summary describing what you changed versus the prior profile and any drift you observed toward the recent posts.

Be specific and grounded in the samples — do not invent traits the samples don't demonstrate.

You are describing one person, not prescribing how they should write. This profile is read back by tools that decide which parts of a draft to leave alone, so a generic trait becomes a standing order to edit this person into the average writer. Two rules follow from that. First, every field must distinguish them from another competent writer in the same genre: if a sentence you wrote would be equally true of any blog in this space ("informative and authoritative", "clear and concise", "delivers information efficiently"), it is describing the genre, not them, and you must replace it with what is actually on the page. Second, never phrase a field as writing advice — "avoid overly casual language" is advice, while "writes the way he talks, contractions and asides throughout" is a description. Their quirks, jokes, digressions, and rough edges are the most valuable thing in this profile; record them as traits, never as things to fix. Output only the structured result.`;

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
  const input = `=== CURRENT PROFILE (${platform}) ===\n${
    currentProfile ? JSON.stringify(currentProfile, null, 2) : "(none yet — build it from scratch)"
  }\n\n=== RECENT POSTS (newest-published first, recency-weighted) ===\n${
    recent.map((s, i) => `[${i + 1}]${voiceSampleLabel(s)} ${s.text}`).join("\n\n")
  }${steeringBlock}\n\nReturn the updated profile as the structured result.`;

  return invokeStructured({
    system: REFLECT_SYSTEM_PROMPT,
    input,
    schema: VOICE_PROFILE_UPDATE_SCHEMA,
    temperature: 0.3,
    maxTokens: 2048,
  });
}

// record_voice_assessment: Record a structured assessment of how well a draft
// matches the user's learned voice.
const VOICE_ASSESSMENT_SCHEMA = z.object({
  score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("How on-voice the draft is, 0 (nothing like them) to 100 (indistinguishable from their own writing)."),
  verdict: z
    .enum(["on_voice", "close", "off_voice"])
    .describe("'on_voice' (>=80), 'close' (50-79, needs small tweaks), 'off_voice' (<50, substantial rework)."),
  summary: z
    .string()
    .describe(
      "One-paragraph plain-English assessment of how well the draft sounds like them, written in the second person ('This reads like you, but...').",
    ),
  strengths: z
    .array(z.string())
    .optional()
    .describe("Specific things the draft gets right about their voice (tone, phrasing, structure)."),
  issues: z
    .array(
      z.object({
        area: z
          .string()
          .optional()
          .describe("What aspect is off: tone, vocabulary, sentence-structure, formatting, signature-phrases, ..."),
        detail: z.string().describe("What's off-voice, quoting or referencing the draft."),
        suggestion: z.string().describe("How to bring it back into their voice."),
      }),
    )
    .optional()
    .describe("Concrete places the draft drifts off-voice, strongest first."),
  on_voice_rewrite: z
    .string()
    .optional()
    .describe(
      "Optional: a short revised version (or the opening) rewritten in their voice, when a concrete example would help. Omit for already on-voice drafts.",
    ),
});

const ASSESS_SYSTEM_PROMPT = `You judge whether a draft sounds like one specific person, using their learned style profile and a few of their real past posts (annotated with publish dates) as the ground truth for their voice. Their voice is defined by how they write NOW — weight the more recently published examples most heavily when deciding what "on-voice" means.

Assess the draft against that voice and return your judgment as a structured result: a 0-100 score, a verdict, a plain-English summary written to the person ("This reads like you, but the second paragraph is more formal than you usually get"), the specific strengths, and the concrete off-voice issues with fixes. Judge VOICE and STYLE — tone, rhythm, vocabulary, signature phrases, formatting habits — not the factual content or the topic. A draft on an unusual topic can still be perfectly on-voice. Be honest and specific; ground every point in the profile or the examples. Do not write prose outside the structured result.`;

// Assesses how well a draft matches the user's learned voice. `profile` is the
// stored VoiceProfile.profile JSON (or null); `samples` are recency-ranked
// examples ([{ text, publishedAt? }]); `draft` is the text to grade. Returns
// { score, verdict, summary, strengths?, issues?, on_voice_rewrite? }.
export async function assessVoiceMatch({ platform, profile, samples, draft }) {
  const examples = (samples ?? []).filter((s) => s?.text);
  const exampleBlock = examples.length > 0
    ? examples.map((s, i) => `[${i + 1}]${voiceSampleLabel(s)} ${s.text}`).join("\n\n")
    : "(no examples yet)";

  const input = `=== STYLE PROFILE (${platform}) ===\n${
    profile ? JSON.stringify(profile, null, 2) : "(no learned profile yet — judge from the examples below)"
  }\n\n=== THEIR PAST POSTS (ground truth for their voice; ordered by relevance + recency) ===\n${exampleBlock}\n\n=== DRAFT TO ASSESS ===\n${draft}\n=== END DRAFT ===\n\nAssess how on-voice the draft is and return the structured result.`;

  return invokeStructured({
    system: ASSESS_SYSTEM_PROMPT,
    input,
    schema: VOICE_ASSESSMENT_SCHEMA,
    temperature: 0.2,
    maxTokens: 1536,
  });
}

const COMPOSE_STREAM_SYSTEM = `You are a ghostwriter who writes in one specific person's voice. You are given a structured style profile describing how they write, and a few of their past posts as examples, each annotated with its publish date when known.

Write a NEW post on the requested topic for the requested platform that authentically matches their voice — tone, sentence structure, vocabulary, signature phrases, and formatting. Their voice evolves over time: the examples are ordered by a blend of topical relevance and recency, and when examples conflict stylistically, favor the more recently published ones — they are the truest signal of how this person writes NOW. Match the format: 'social' = short, punchy, platform-native (no title); 'blog' = long-form markdown that starts with a single '# Title' line followed by the body.

Emulate the style, do not copy the example posts' content. Output ONLY the post itself — no preamble, no commentary, no surrounding quotes.`;

// Streams a composed post in the user's voice. Mirrors composeVoicePost's
// inputs (samples pre-ranked by relevance + recency); yields text deltas.
export function streamVoicePost({ topic, platform, format, profile, samples, guidance }) {
  const examples = (samples ?? []).filter((s) => s?.text);
  const exampleBlock = examples.length > 0
    ? examples.map((s, i) => {
      const date = typeof s.publishedAt === "string" && s.publishedAt.length > 0
        ? ` (published ${s.publishedAt.slice(0, 10)})`
        : "";
      return `[${i + 1}]${date} ${s.text}`;
    }).join("\n\n")
    : "(no examples yet)";

  const userText = `=== STYLE PROFILE (${platform}) ===\n${
    profile ? JSON.stringify(profile, null, 2) : "(no learned profile yet — infer the voice from the examples below)"
  }\n\n=== PAST POSTS (ordered by relevance + recency; emulate, don't copy) ===\n${exampleBlock}\n\n=== TASK ===\nWrite a ${
    format === "blog" ? "long-form blog post" : "short social post"
  } for ${platform} about:\n${topic}${guidance ? `\n\nAdditional guidance: ${guidance}` : ""}`;

  return streamConverseText({
    system: COMPOSE_STREAM_SYSTEM,
    userText,
    temperature: 0.6,
    maxTokens: composeMaxTokens(format),
  });
}
