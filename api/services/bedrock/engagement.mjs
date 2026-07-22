import { invokeToolUse } from "./client.mjs";

// Engagement recommendations: propose where else to cross-post or promote a
// piece of content, grounded in its existing distribution history.

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
