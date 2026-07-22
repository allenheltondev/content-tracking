import { z } from "zod";
import { invokeStructured } from "./client.mjs";

// ---------------------------------------------------------------------------
// Content Radar: read what the creator's subscribed feeds are publishing right
// now and propose fresh content angles that follow THIS creator's voice and
// build on the topics they already cover. Grounds every angle in the actual
// feed items (cited by number) so ideas are anchored in the conversation
// happening now, not invented.
// ---------------------------------------------------------------------------

// record_content_angles: Record content angles and topic ideas derived from
// what the creator's subscribed feeds are currently publishing, tailored to
// the creator's voice.
const CONTENT_ANGLES_SCHEMA = z.object({
  summary: z
    .string()
    .describe(
      "Two- to three-sentence read on what's being talked about across the feeds right now and where the strongest openings are for this creator.",
    ),
  themes: z
    .array(
      z.object({
        theme: z.string().describe("Short name for the theme (a few words)."),
        momentum: z
          .enum(["surging", "steady", "emerging", "fading"])
          .optional()
          .describe("How much energy this theme has across the feeds right now."),
        why_it_fits: z
          .string()
          .optional()
          .describe(
            "Why this theme is (or isn't) a natural fit for this creator, given their voice and the topics they already build on.",
          ),
      }),
    )
    .optional()
    .describe(
      "The distinct themes surfacing across the feed items right now, strongest first. A theme groups related stories; aim for 2-5.",
    ),
  angles: z
    .array(
      z.object({
        title: z
          .string()
          .describe("A working headline for the piece, written the way this creator titles their work."),
        angle: z
          .string()
          .describe(
            "The specific take or argument — what the creator would say that the feeds aren't already saying, and why it's theirs to make.",
          ),
        format: z
          .string()
          .optional()
          .describe(
            "Suggested format/platform for this idea (e.g. blog, x thread, linkedin post, newsletter), matching where the creator publishes.",
          ),
        rationale: z
          .string()
          .describe(
            "Why this angle lands now: what in the feeds makes it timely and how it extends the creator's existing topics.",
          ),
        on_voice_note: z
          .string()
          .optional()
          .describe(
            "How to keep it on-voice — the tone, structure, or signature moves from this creator's style to apply.",
          ),
        sources: z
          .array(z.number().int().min(1))
          .optional()
          .describe("The [n] feed-item numbers this angle draws on. Empty when it's a net-new connection."),
      }),
    )
    .describe(
      "Concrete content ideas the creator could publish, strongest first. Aim for 4-8 high-quality angles, each a fresh take rather than a rehash of a feed item.",
    ),
});

const CONTENT_ANGLES_SYSTEM_PROMPT = `You are a content strategist for a specific solo creator. You are given (1) a snapshot of what the RSS/Atom feeds they follow are publishing right now, as a numbered list of items; (2) their learned writing voice — one or more plain-English voice "portraits" describing how they sound on each platform; and (3) the recent topics they've been building on (titles of their own recent work). Your job is to spot where the current conversation intersects with what this creator does, and propose content angles they could publish that authentically sound like them.

Return your ideas as a structured result. Do all of the following:
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
- Do not write prose outside the structured result.`;

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
  const input = `Propose content angles from the current feed snapshot as a structured result.\n\n${contextBlock}`;

  return invokeStructured({
    system: CONTENT_ANGLES_SYSTEM_PROMPT,
    input,
    schema: CONTENT_ANGLES_SCHEMA,
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
