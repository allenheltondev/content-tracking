import { defaultGa4Range, loadGa4Section } from "./ga4.mjs";

// Campaign adapter over the shared GA4 core: derives the page path from
// the campaign's blog URL and stamps blog_url/page_path onto the section
// so both the live web-analytics endpoint and the frozen campaign report
// snapshot read from the same code path. Always resolves — missing blog
// URL, missing config, and upstream failures all become a structured
// `configured`/`error` field rather than throwing.

// Pull GA4 traffic for a campaign's blog post. Returns null when the
// campaign has no blog URL (nothing to look up) or the URL doesn't parse.
// Otherwise returns a section object with `configured` + (when configured
// and successful) the report payload.
export async function loadCampaignGa4(campaign, { startDate, endDate } = {}) {
  if (!campaign?.blogUrl) return null;

  let pagePath;
  try {
    pagePath = new URL(campaign.blogUrl).pathname || "/";
  } catch {
    return null;
  }

  const range = startDate && endDate ? { startDate, endDate } : defaultGa4Range();
  const section = await loadGa4Section({ pagePath, ...range });

  if (!section.configured || section.error) {
    return { ...section, blog_url: campaign.blogUrl, page_path: pagePath };
  }
  return { ...section, blog_url: campaign.blogUrl };
}
