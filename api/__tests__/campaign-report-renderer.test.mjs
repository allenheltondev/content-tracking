import { describe, it, expect } from "@jest/globals";
import { renderCampaignReportHtml } from "../services/campaign-report-renderer.mjs";

function sampleSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    report: {
      id: "rep_camp_1",
      generatedAt: "2026-05-29T12:00:00.000Z",
      dataAsOf: "2026-05-28",
      kind: "campaign",
    },
    campaign: {
      id: "camp_1",
      name: "Spring Launch Campaign",
      sponsor: "Acme Corp",
      startDate: "2026-01-01",
      endDate: "2026-05-28",
    },
    summary: {
      totalClicks: 1234,
      linkCount: 3,
      upstreamFailures: 0,
    },
    reach: {
      content: { views: 0, impressions: 0, engagements: 0 },
      social: { views: 0, impressions: 0, engagements: 0 },
      totals: { views: 0, impressions: 0, engagements: 0 },
    },
    bySrc: [
      { source: "twitter", clicks: 800, share: 0.6483 },
      { source: "newsletter", clicks: 434, share: 0.3517 },
    ],
    byDay: [
      { day: "2026-01-02", clicks: 100 },
      { day: "2026-01-03", clicks: 220 },
    ],
    links: [
      {
        url: "https://example.com/landing",
        role: "primary",
        platform: "web",
        totalClicks: 900,
      },
      {
        url: "https://example.com/secondary",
        role: null,
        platform: null,
        totalClicks: 334,
      },
    ],
    mainContent: null,
    socialPosts: [],
    contentPosts: [],
    ...overrides,
  };
}

describe("renderCampaignReportHtml", () => {
  it("renders the campaign name and a complete HTML document", () => {
    const html = renderCampaignReportHtml(sampleSnapshot());
    expect(typeof html).toBe("string");
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("Spring Launch Campaign");
    expect(html).toContain("</html>");
  });

  it("includes the noindex/no-referrer robots metadata", () => {
    const html = renderCampaignReportHtml(sampleSnapshot());
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).toContain('name="robots"');
    expect(html).toContain('content="no-referrer"');
  });

  it("replaces the __REPORT_DATA__ token with the embedded JSON", () => {
    const html = renderCampaignReportHtml(sampleSnapshot());
    expect(html).not.toContain("__REPORT_DATA__");
    expect(html).toContain('id="report-data"');
  });

  it("escapes a script-breakout attempt in link/source data so </script> never appears raw", () => {
    const payload = "</script><script>alert(1)</script>";
    const snapshot = sampleSnapshot();
    snapshot.links[0].url = payload;
    snapshot.bySrc[0].source = payload;
    const html = renderCampaignReportHtml(snapshot);

    // The raw closing-script sequence from the data must not survive: the "<"
    // must have been escaped to its < unicode form.
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script\\u003e");

    // There should be exactly the two real script tags from the template, not
    // an injected one from the payload.
    const openTags = html.match(/<script\b/gi) || [];
    expect(openTags.length).toBe(2);
  });

  it("escapes U+2028 and U+2029 separators in the embedded JSON", () => {
    const snapshot = sampleSnapshot();
    snapshot.campaign.name = "Line Para End";
    const html = renderCampaignReportHtml(snapshot);
    expect(html).not.toContain(" ");
    expect(html).not.toContain(" ");
    expect(html).toContain("\\u2028");
    expect(html).toContain("\\u2029");
  });

  it("is fully self-contained with no external CDN resources", () => {
    const html = renderCampaignReportHtml(sampleSnapshot());
    const externalRef = /(?:src|href)\s*=\s*["']https?:\/\//gi;
    expect(html).not.toMatch(externalRef);
    expect(html).not.toMatch(/<link\b[^>]*\bhref=/i);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
  });

  it("does not leak payout or currency wording (performance only)", () => {
    const html = renderCampaignReportHtml(sampleSnapshot());
    expect(html).not.toContain("$");
    expect(html.toLowerCase()).not.toContain("payout");
    expect(html.toLowerCase()).not.toContain("revenue");
    expect(html).not.toContain("USD");
  });

  it("does not interpret '$' replacement patterns from the data", () => {
    const snapshot = sampleSnapshot();
    snapshot.campaign.name = "Cost $1 & $$ & $`drop";
    const html = renderCampaignReportHtml(snapshot);
    expect(html).toContain("Cost $1 \\u0026 $$ \\u0026 $`drop");
  });

  it("drops short URL and first/last clicked from the links table columns", () => {
    const html = renderCampaignReportHtml(sampleSnapshot());
    // The customer report intentionally removes these three link columns.
    // Their user-facing labels should not appear anywhere in the document.
    expect(html).not.toContain('"Short URL"');
    expect(html).not.toContain('"First clicked"');
    expect(html).not.toContain('"Last clicked"');
    // And the corresponding column-array entries — guarding against a key
    // surviving in the array while the label was renamed.
    expect(html).not.toContain('key: "shortUrl"');
    expect(html).not.toContain('key: "firstClickAt"');
    expect(html).not.toContain('key: "lastClickAt"');
  });

  it("embeds main content + post data + reach buckets into the snapshot JSON when present", () => {
    const snapshot = sampleSnapshot({
      brand: { name: "Ready, Set, Cloud!", websiteUrl: "https://readysetcloud.io" },
      mainContent: {
        blogUrl: "https://blog.example.com/post-x",
        range: { startDate: "2026-05-01", endDate: "2026-05-28" },
        pageviews: 4200,
        users: 3100,
        sessions: 3500,
        avgSessionDurationSeconds: 95,
        engagementRate: 0.81,
      },
      reach: {
        content: { views: 5000, impressions: 0, engagements: 2835 },
        social: { views: 0, impressions: 12000, engagements: 42 },
        totals: { views: 5000, impressions: 12000, engagements: 2877 },
      },
      socialPosts: [
        {
          platform: "twitter",
          url: "https://twitter.com/u/status/1",
          notes: null,
          views: 0,
          impressions: 12000,
          engagements: 42,
          topMetric: "impressions",
          topMetricValue: 12000,
          lastFetched: "2026-05-28T09:00:00.000Z",
        },
      ],
      contentPosts: [
        {
          platform: "medium",
          url: "https://medium.com/@u/post",
          notes: null,
          views: 800,
          impressions: 0,
          engagements: 700,
          topMetric: "views",
          topMetricValue: 800,
          lastFetched: "2026-05-28T09:00:00.000Z",
        },
      ],
    });
    const html = renderCampaignReportHtml(snapshot);
    expect(html).toContain('"pageviews":4200');
    expect(html).toContain('"avgSessionDurationSeconds":95');
    expect(html).toContain('"impressions":12000');
    expect(html).toContain("https://twitter.com/u/status/1");
    expect(html).toContain("https://medium.com/@u/post");
    expect(html).toContain("Ready, Set, Cloud!");
    expect(html).toContain("https://readysetcloud.io");
  });
});
