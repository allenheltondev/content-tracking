import { z } from "zod";
import { assertCampaignOwned } from "../../../api/domain/campaign.mjs";
import { createContentPost, deleteContentPost, updateContentPostAnalytics } from "../../../api/domain/content-post.mjs";
import { createLink, deleteLink, updateLink } from "../../../api/domain/link.mjs";
import { createSocialPost, deleteSocialPost, updateSocialPostAnalytics } from "../../../api/domain/social-post.mjs";
import { runOnce } from "../../../api/services/idempotency.mjs";
import {
  VALID_CONTENT_PLATFORMS,
  formatContentPost,
  validateAnalyticsUpdate as validateContentMetrics,
  validateContentPostCreate,
} from "../../../api/validation/content-post.mjs";
import { LINK_ROLES, formatLink, validateLinkCreate, validateLinkUpdate } from "../../../api/validation/link.mjs";
import {
  VALID_PLATFORMS,
  formatSocialPost,
  validateAnalyticsUpdate as validateSocialMetrics,
  validateSocialPostCreate,
} from "../../../api/validation/social-post.mjs";
import { DELETE, UPDATE, WRITE, anyObject, guarded, id, idempotencyKey } from "../shared.mjs";

// What a campaign tracks: short links (clicks via newsletter-service),
// social posts, and cross-posted content, each with its own metrics. Every
// tool checks the campaign belongs to the caller before touching its
// children.

const metricsArgs = {
  metrics: z
    .record(z.string(), z.number().min(0))
    .describe("Metric name to count, for example { likes: 120, comments: 8 }. Replaces the stored metrics."),
  capturedAt: z.string().optional().describe("ISO date-time the numbers were read. Defaults to now."),
};

export function registerDeliverableTools(server, { tenantId }) {
  const owned = (campaignId) => assertCampaignOwned(campaignId, tenantId);

  server.registerTool(
    "add_campaign_link",
    {
      title: "Add tracked link",
      description:
        "Mint a tracked short link for a campaign. role is main (the sponsored post), cross_post, or social_promo. Returns short_url to share.",
      inputSchema: z.object({
        campaign_id: id("campaign"),
        role: z.enum(LINK_ROLES),
        platform: z.string().min(1).max(64).describe("Where the link is shared, for example blog or twitter."),
        url: z.string().describe("Destination URL (http or https)."),
        src: z.string().max(64).optional().describe("Source tag appended for attribution."),
        notes: z.string().optional(),
        expiresInDays: z.number().int().min(1).max(1825).optional(),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: z.object({ link: anyObject }),
      annotations: WRITE,
    },
    guarded(async ({ campaign_id: campaignId, idempotency_key: key, ...body }) => {
      await owned(campaignId);
      const fields = validateLinkCreate(body);
      const item = await runOnce({
        operation: `add_campaign_link#${campaignId}`,
        tenantId,
        idempotencyKey: key,
        fields,
        run: () => createLink(campaignId, fields),
      });
      return { link: formatLink(item, { includeCampaignId: true }) };
    }),
  );

  // Only notes are editable. The short link's redirect, src attribution, and
  // expiry live in newsletter-service, which has no update API, so changing
  // them on Booked's row would not change the live link.
  server.registerTool(
    "update_campaign_link",
    {
      title: "Update tracked link notes",
      description:
        "Edit a tracked link's notes, which are kept in Booked only. The destination, role, src tag, and expiry are fixed when the link is minted; to change them, delete the link and add a new one.",
      inputSchema: z.object({
        campaign_id: id("campaign"),
        link_id: id("link"),
        notes: z.string().nullable().describe("null clears the notes."),
      }),
      outputSchema: z.object({ link: anyObject }),
      annotations: UPDATE,
    },
    guarded(async ({ campaign_id: campaignId, link_id: linkId, notes }) => {
      await owned(campaignId);
      const fields = validateLinkUpdate({ notes });
      return { link: formatLink(await updateLink(campaignId, linkId, fields), { includeCampaignId: true }) };
    }),
  );

  server.registerTool(
    "delete_campaign_link",
    {
      title: "Delete tracked link",
      description: "Delete a tracked link and retire its short URL. Clicks on it stop being counted.",
      inputSchema: z.object({ campaign_id: id("campaign"), link_id: id("link") }),
      outputSchema: z.object({ deleted: z.boolean(), link_id: z.string() }),
      annotations: DELETE,
    },
    guarded(async ({ campaign_id: campaignId, link_id: linkId }) => {
      await owned(campaignId);
      await deleteLink(campaignId, linkId);
      return { deleted: true, link_id: linkId };
    }),
  );

  server.registerTool(
    "add_social_post",
    {
      title: "Add social post",
      description: `Track a social post for a campaign. platform is derived from the URL when omitted (${[...VALID_PLATFORMS].join(", ")}).`,
      inputSchema: z.object({
        campaign_id: id("campaign"),
        url: z.string(),
        platform: z.enum([...VALID_PLATFORMS]).optional(),
        notes: z.string().optional(),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: z.object({ social_post: anyObject }),
      annotations: WRITE,
    },
    guarded(async ({ campaign_id: campaignId, idempotency_key: key, ...body }) => {
      await owned(campaignId);
      const fields = validateSocialPostCreate(body);
      const item = await runOnce({
        operation: `add_social_post#${campaignId}`,
        tenantId,
        idempotencyKey: key,
        fields,
        run: () => createSocialPost(campaignId, fields),
      });
      return { social_post: formatSocialPost(item) };
    }),
  );

  server.registerTool(
    "record_social_post_metrics",
    {
      title: "Record social post metrics",
      description: "Store the latest engagement numbers for a social post. Also adds today's point to its history.",
      inputSchema: z.object({ campaign_id: id("campaign"), post_id: id("social post"), ...metricsArgs }),
      outputSchema: z.object({ social_post: anyObject }),
      annotations: UPDATE,
    },
    guarded(async ({ campaign_id: campaignId, post_id: postId, ...body }) => {
      await owned(campaignId);
      const fields = validateSocialMetrics(body);
      return { social_post: formatSocialPost(await updateSocialPostAnalytics(campaignId, postId, fields)) };
    }),
  );

  server.registerTool(
    "delete_social_post",
    {
      title: "Delete social post",
      description: "Stop tracking a social post and drop its metrics.",
      inputSchema: z.object({ campaign_id: id("campaign"), post_id: id("social post") }),
      outputSchema: z.object({ deleted: z.boolean(), post_id: z.string() }),
      annotations: DELETE,
    },
    guarded(async ({ campaign_id: campaignId, post_id: postId }) => {
      await owned(campaignId);
      await deleteSocialPost(campaignId, postId);
      return { deleted: true, post_id: postId };
    }),
  );

  server.registerTool(
    "add_content_post",
    {
      title: "Add content post",
      description: `Track a cross-posted article for a campaign. platform is derived from the URL when omitted (${[...VALID_CONTENT_PLATFORMS].join(", ")}).`,
      inputSchema: z.object({
        campaign_id: id("campaign"),
        url: z.string(),
        platform: z.enum([...VALID_CONTENT_PLATFORMS]).optional(),
        notes: z.string().optional(),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: z.object({ content_post: anyObject }),
      annotations: WRITE,
    },
    guarded(async ({ campaign_id: campaignId, idempotency_key: key, ...body }) => {
      await owned(campaignId);
      const fields = validateContentPostCreate(body);
      const item = await runOnce({
        operation: `add_content_post#${campaignId}`,
        tenantId,
        idempotencyKey: key,
        fields,
        run: () => createContentPost(campaignId, fields),
      });
      return { content_post: formatContentPost(item) };
    }),
  );

  server.registerTool(
    "record_content_post_metrics",
    {
      title: "Record content post metrics",
      description: "Store the latest numbers (views, reads, reactions) for a content post. Also adds today's point to its history.",
      inputSchema: z.object({ campaign_id: id("campaign"), post_id: id("content post"), ...metricsArgs }),
      outputSchema: z.object({ content_post: anyObject }),
      annotations: UPDATE,
    },
    guarded(async ({ campaign_id: campaignId, post_id: postId, ...body }) => {
      await owned(campaignId);
      const fields = validateContentMetrics(body);
      return { content_post: formatContentPost(await updateContentPostAnalytics(campaignId, postId, fields)) };
    }),
  );

  server.registerTool(
    "delete_content_post",
    {
      title: "Delete content post",
      description: "Stop tracking a content post and drop its metrics.",
      inputSchema: z.object({ campaign_id: id("campaign"), post_id: id("content post") }),
      outputSchema: z.object({ deleted: z.boolean(), post_id: z.string() }),
      annotations: DELETE,
    },
    guarded(async ({ campaign_id: campaignId, post_id: postId }) => {
      await owned(campaignId);
      await deleteContentPost(campaignId, postId);
      return { deleted: true, post_id: postId };
    }),
  );
}
