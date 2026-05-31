import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import { validateProfileUpdate } from "../validation/profile.mjs";
import {
  validateCreatorProfileUpdate,
  validateProfileImageUploadRequest,
} from "../validation/creator-profile.mjs";
import { getProfileSettings, saveProfileSettings } from "../domain/profile.mjs";
import {
  presignProfileImageUpload,
  signProfileAssetUrl,
} from "../services/profile-assets.mjs";
import { publicMediaKitUrl } from "../services/public-media-kit-store.mjs";
import {
  readCruxApiKey,
  readGa4ServiceAccount,
  writeCruxApiKey,
  writeGa4ServiceAccount,
} from "../services/ga-secrets.mjs";

// The single SETTINGS/PROFILE row carries two concerns: integration
// settings (GA4 + CrUX, secrets in SSM) and the creator profile that the
// media kit and shared reports render from. Both are edited through
// PUT /profile; secrets are never echoed back.

// Dashboard preview links for avatar/logo. The media kit signs its own
// longer-lived URLs at render time; this is just so Settings can show the
// current images.
const ASSET_PREVIEW_TTL_SECONDS = 7 * 24 * 60 * 60;

export function registerProfileRoutes(app) {
  app.get("/profile", async () => {
    return jsonResponse(200, await buildProfileView());
  });

  app.put("/profile", async ({ event }) => {
    const body = parseBody(event);
    const fields = validateProfileUpdate(body);
    const creator = validateCreatorProfileUpdate(body);

    if (fields.ga4ServiceAccount) {
      await writeGa4ServiceAccount(fields.ga4ServiceAccount);
    }
    if (fields.cruxApiKey) {
      await writeCruxApiKey(fields.cruxApiKey);
    }

    // Non-secret integration fields + every creator-profile field share one
    // DynamoDB write. validateProfileUpdate and validateCreatorProfileUpdate
    // own disjoint key sets, so the merge can't collide.
    const nonSecret = {};
    if (fields.ga4PropertyId) nonSecret.ga4PropertyId = fields.ga4PropertyId;
    if (fields.brandName) nonSecret.brandName = fields.brandName;
    if (fields.websiteUrl) nonSecret.websiteUrl = fields.websiteUrl;
    Object.assign(nonSecret, creator);
    if (Object.keys(nonSecret).length > 0) {
      await saveProfileSettings(nonSecret);
    }

    logger.info("Profile settings updated", {
      ga4PropertyId: fields.ga4PropertyId ? "set" : "unchanged",
      ga4ServiceAccount: fields.ga4ServiceAccount ? "set" : "unchanged",
      cruxApiKey: fields.cruxApiKey ? "set" : "unchanged",
      creatorFields: Object.keys(creator),
    });

    // forceFetch so the response reflects the just-written secrets rather
    // than Powertools' 5-minute cache.
    return jsonResponse(200, await buildProfileView({ forceFetch: true }));
  });

  // Mint a presigned S3 PUT for an avatar or logo. The dashboard uploads the
  // image directly, then persists the returned key via PUT /profile
  // ({ avatar_key } or { logo_key }).
  app.post("/profile/images/upload-url", async ({ event }) => {
    const { kind, contentType } = validateProfileImageUploadRequest(parseBody(event));
    const { key, url, expiresAt } = await presignProfileImageUpload({ kind, contentType });
    return jsonResponse(200, { kind, key, url, expiresAt });
  });
}

async function buildProfileView({ forceFetch = false } = {}) {
  const [settings, serviceAccount, cruxKey] = await Promise.all([
    getProfileSettings(),
    readGa4ServiceAccount({ forceFetch }),
    readCruxApiKey({ forceFetch }),
  ]);

  const s = settings ?? {};
  const [avatarUrl, logoUrl] = await Promise.all([
    previewAssetUrl(s.avatarKey),
    previewAssetUrl(s.logoKey),
  ]);

  return {
    brand: {
      name: s.brandName ?? null,
      website_url: s.websiteUrl ?? null,
    },
    identity: {
      display_name: s.displayName ?? null,
      tagline: s.tagline ?? null,
      bio: s.bio ?? null,
      location: s.location ?? null,
      contact_email: s.contactEmail ?? null,
      accent_color: s.accentColor ?? null,
      niches: s.niches ?? [],
      avatar_key: s.avatarKey ?? null,
      avatar_url: avatarUrl,
      logo_key: s.logoKey ?? null,
      logo_url: logoUrl,
    },
    social_accounts: s.socialAccounts ?? [],
    audience: s.audience ?? null,
    rate_card: s.rateCard ?? [],
    testimonials: s.testimonials ?? [],
    featured_collaborations: s.featuredCollaborations ?? [],
    public_media_kit: {
      slug: s.publicSlug ?? null,
      published: Boolean(s.publicMediaKitPublishedAt),
      url: s.publicSlug && s.publicMediaKitPublishedAt ? publicMediaKitUrl(s.publicSlug) : null,
      published_at: s.publicMediaKitPublishedAt ?? null,
    },
    ga4: {
      property_id: s.ga4PropertyId ?? null,
      service_account_email: serviceAccount?.client_email ?? null,
      configured: Boolean(s.ga4PropertyId && serviceAccount),
    },
    core_web_vitals: {
      configured: Boolean(cruxKey),
    },
    updated_at: s.updatedAt ?? null,
  };
}

// A signing failure (e.g. CDN key not provisioned in a fresh stack) must
// not take down the whole profile read — the image just comes back without
// a preview URL.
async function previewAssetUrl(key) {
  if (!key) return null;
  try {
    const { url } = signProfileAssetUrl(key, { expiresInSeconds: ASSET_PREVIEW_TTL_SECONDS });
    return url;
  } catch (err) {
    logger.warn("Failed to sign profile asset url", { key, error: err?.message });
    return null;
  }
}

function parseBody(event) {
  if (!event.body) {
    throw new BadRequestError("Missing request body");
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}
