import { z } from "zod";
import { assertCampaignOwned } from "../../../api/domain/campaign.mjs";
import { getCampaignAnalytics } from "../../../api/services/campaign-analytics.mjs";
import { generateCampaignReport, listCampaignReports } from "../../../api/services/campaign-reports.mjs";
import { loadCampaignWebAnalytics } from "../../../api/services/campaign-web-analytics.mjs";
import { READ, WRITE, anyObject, guarded, id, isoDate } from "../shared.mjs";

// Performance and sponsor-facing reports. The numbers are the same ones the
// dashboard and the generated report show.

export function registerReportingTools(server, { tenantId, publicReportUrl }) {
  server.registerTool(
    "get_campaign_analytics",
    {
      title: "Get campaign analytics",
      description:
        "Click analytics for a campaign's tracked links, in total and per link. upstream_failures counts links whose clicks could not be fetched. Post metrics are on get_campaign.",
      inputSchema: z.object({ campaign_id: id("campaign") }),
      outputSchema: anyObject,
      annotations: { ...READ, openWorldHint: true },
    },
    guarded(async ({ campaign_id: campaignId }) => {
      await assertCampaignOwned(campaignId, tenantId);
      return getCampaignAnalytics(campaignId);
    }),
  );

  server.registerTool(
    "get_campaign_web_analytics",
    {
      title: "Get campaign web analytics",
      description:
        "Deliverable performance: GA4 traffic and Core Web Vitals for a blog campaign, or YouTube video stats. The date range applies to GA4 and defaults to the last 28 days.",
      inputSchema: z.object({
        campaign_id: id("campaign"),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
      }),
      outputSchema: anyObject,
      annotations: { ...READ, openWorldHint: true },
    },
    guarded(async ({ campaign_id: campaignId, startDate, endDate }) => {
      const campaign = await assertCampaignOwned(campaignId, tenantId);
      return loadCampaignWebAnalytics(campaign, { startDate, endDate });
    }),
  );

  server.registerTool(
    "generate_campaign_report",
    {
      title: "Generate campaign report",
      description:
        "Generate a sponsor-facing performance report. Returns a signed url, a shortUrl when available, and latestUrl, a stable link that always opens the newest report.",
      inputSchema: z.object({ campaign_id: id("campaign") }),
      outputSchema: z.looseObject({ reportId: z.string(), url: z.string() }),
      annotations: WRITE,
    },
    guarded(async ({ campaign_id: campaignId }) => {
      await assertCampaignOwned(campaignId, tenantId);
      return generateCampaignReport({ campaignId, latestUrlFor: publicReportUrl });
    }),
  );

  server.registerTool(
    "list_campaign_reports",
    {
      title: "List campaign reports",
      description: "List a campaign's retained reports, newest first, each with a fresh signed link.",
      inputSchema: z.object({ campaign_id: id("campaign") }),
      outputSchema: z.object({ latest_url: z.string().nullable(), reports: z.array(anyObject) }),
      annotations: READ,
    },
    guarded(async ({ campaign_id: campaignId }) => {
      await assertCampaignOwned(campaignId, tenantId);
      const { latestUrl, reports } = await listCampaignReports({ campaignId, latestUrlFor: publicReportUrl });
      return { latest_url: latestUrl ?? null, reports };
    }),
  );
}
