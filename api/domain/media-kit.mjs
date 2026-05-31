import { listCampaigns } from "./campaign.mjs";
import { listSocialPosts } from "./social-post.mjs";
import { listContentPosts } from "./content-post.mjs";
import { getProfileSettings } from "./profile.mjs";
import { splitPostMetrics } from "./post-metrics.mjs";
import { signProfileAssetUrl } from "../services/profile-assets.mjs";
import { logger } from "../services/logger.mjs";

// Builds a frozen, brand-facing media-kit snapshot for the (single-tenant)
// creator. Combines the configurable profile — identity, social accounts,
// audience, rate card, testimonials, featured collaborations — with live
// aggregate performance across every campaign the creator has run. Pure
// read-side glue; the only writes happen in the route that persists the
// rendered artifact.

const ASSET_TTL_DEFAULT_SECONDS = 90 * 24 * 60 * 60;

export async function buildMediaKitSnapshot({ assetUrlTtlSeconds = ASSET_TTL_DEFAULT_SECONDS } = {}) {
  const [profile, campaigns] = await Promise.all([
    getProfileSettings(),
    listAllCampaigns(),
  ]);
  const p = profile ?? {};

  // Fan out to each campaign's partition for its tracked posts, then fold
  // the open-ended metric maps into reach/engagement totals. Personal-scale
  // data set, so the per-campaign fan-out mirrors the existing analytics and
  // monitoring-working-set patterns.
  const postBatches = await Promise.all(
    campaigns.map(async (c) => {
      const [social, content] = await Promise.all([
        listSocialPosts(c.campaignId),
        listContentPosts(c.campaignId),
      ]);
      return [...social, ...content];
    }),
  );
  const posts = postBatches.flat();

  const reach = { views: 0, impressions: 0, engagements: 0 };
  for (const post of posts) {
    const m = splitPostMetrics(post.analytics);
    reach.views += m.views;
    reach.impressions += m.impressions;
    reach.engagements += m.engagements;
  }

  const socialAccounts = Array.isArray(p.socialAccounts) ? p.socialAccounts : [];
  const totalFollowers = socialAccounts.reduce(
    (sum, a) => sum + (typeof a.followers === "number" ? a.followers : 0),
    0,
  );

  const campaignsCompleted = campaigns.filter((c) => c.status === "completed").length;
  const totalReach = reach.views + reach.impressions;
  // Engagement rate is engagements over reach (views + impressions). Null
  // when there's no reach to divide by, so the renderer can hide it rather
  // than show a misleading 0%.
  const engagementRate = totalReach > 0 ? reach.engagements / totalReach : null;

  const now = new Date();

  return {
    schemaVersion: 1,
    report: {
      id: null,
      generatedAt: now.toISOString(),
      dataAsOf: now.toISOString().slice(0, 10),
      kind: "media-kit",
    },
    brand: buildBrand(p),
    identity: {
      displayName: p.displayName ?? p.brandName ?? null,
      tagline: p.tagline ?? null,
      bio: p.bio ?? null,
      location: p.location ?? null,
      contactEmail: p.contactEmail ?? null,
      accentColor: p.accentColor ?? null,
      niches: Array.isArray(p.niches) ? p.niches : [],
      avatarUrl: signAsset(p.avatarKey, assetUrlTtlSeconds),
      logoUrl: signAsset(p.logoKey, assetUrlTtlSeconds),
    },
    socialAccounts: socialAccounts.map((a) => ({
      platform: a.platform ?? null,
      handle: a.handle ?? null,
      url: a.url ?? null,
      followers: typeof a.followers === "number" ? a.followers : null,
    })),
    audience: p.audience ?? null,
    rateCard: Array.isArray(p.rateCard) ? p.rateCard : [],
    testimonials: Array.isArray(p.testimonials) ? p.testimonials : [],
    featuredCollaborations: Array.isArray(p.featuredCollaborations) ? p.featuredCollaborations : [],
    stats: {
      totalFollowers,
      platformCount: socialAccounts.length,
      campaignsCompleted,
      campaignsTotal: campaigns.length,
      postsTracked: posts.length,
      totalViews: reach.views,
      totalImpressions: reach.impressions,
      totalReach,
      totalEngagements: reach.engagements,
      engagementRate,
    },
  };
}

// The creator's brand block (name + website), null when no brand name is
// configured so the renderer can omit it.
function buildBrand(profile) {
  const name = profile?.brandName ?? null;
  if (!name) return null;
  return { name, websiteUrl: profile?.websiteUrl ?? null };
}

// Signs a stored avatar/logo key for embedding in the media kit. Signing is
// pure (no network), but a misconfigured CloudFront key would throw — a
// missing image must never sink the whole snapshot, so failures degrade to
// null and the renderer simply omits the image.
function signAsset(key, ttlSeconds) {
  if (!key) return null;
  try {
    const { url } = signProfileAssetUrl(key, { expiresInSeconds: ttlSeconds });
    return url;
  } catch (err) {
    logger.warn("Failed to sign media-kit asset url", { key, error: err?.message });
    return null;
  }
}

// Drains the paginated campaign list into a flat array. The media kit needs
// every campaign regardless of status, so it can't use the status-scoped
// helpers. Personal-scale data set, so fully consuming the pages is fine.
async function listAllCampaigns() {
  const all = [];
  let exclusiveStartKey;
  do {
    const { items, lastEvaluatedKey } = await listCampaigns({
      limit: 500,
      exclusiveStartKey,
    });
    for (const item of items) all.push(item);
    exclusiveStartKey = lastEvaluatedKey;
  } while (exclusiveStartKey);
  return all;
}
