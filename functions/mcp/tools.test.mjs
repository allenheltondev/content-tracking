import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

// Drives the non-campaign-core tools end to end through the handler with
// the domain and heavy services mocked. Validation runs for real.
const { autoMock } = await import("./test-support.mjs");
const mockModule = (path) => jest.unstable_mockModule(path, autoMock(path, import.meta.url));
mockModule("../../api/domain/campaign.mjs");
mockModule("../../api/domain/vendor.mjs");
mockModule("../../api/domain/link.mjs");
mockModule("../../api/domain/social-post.mjs");
mockModule("../../api/domain/content-post.mjs");
mockModule("../../api/domain/draft.mjs");
mockModule("../../api/services/activity.mjs");
mockModule("../../api/services/brief-pipeline.mjs");
mockModule("../../api/services/campaign-analytics.mjs");
mockModule("../../api/services/campaign-reports.mjs");
mockModule("../../api/services/campaign-web-analytics.mjs");
const keyed = [];
jest.unstable_mockModule("../../api/services/idempotency.mjs", () => ({
  runOnce: (args) => {
    if (args.idempotencyKey) keyed.push(args);
    return args.run();
  },
}));

const campaignDomain = await import("../../api/domain/campaign.mjs");
const vendorDomain = await import("../../api/domain/vendor.mjs");
const linkDomain = await import("../../api/domain/link.mjs");
const socialDomain = await import("../../api/domain/social-post.mjs");
const contentDomain = await import("../../api/domain/content-post.mjs");
const draftDomain = await import("../../api/domain/draft.mjs");
const briefPipeline = await import("../../api/services/brief-pipeline.mjs");
const analytics = await import("../../api/services/campaign-analytics.mjs");
const reports = await import("../../api/services/campaign-reports.mjs");
const webAnalytics = await import("../../api/services/campaign-web-analytics.mjs");
const { NotFoundError } = await import("../../api/services/errors.mjs");
const { handler } = await import("./index.mjs");
const { SUB, mcpClient } = await import("./test-support.mjs");
const { callTool } = mcpClient(handler);

const CAMPAIGN = { campaignId: "C1", name: "Launch", status: "active", createdAt: "2026-11-01T00:00:00.000Z" };
const at = "2026-11-01T00:00:00.000Z";

beforeEach(() => {
  // reset, not clear: a test's mockRejectedValue must not leak into the next.
  jest.resetAllMocks();
  keyed.length = 0;
  campaignDomain.assertCampaignOwned.mockResolvedValue(CAMPAIGN);
});

describe("campaign tools", () => {
  test("get_campaign returns the detail for an owned campaign", async () => {
    campaignDomain.getCampaignWithLinks.mockResolvedValue({
      metadata: CAMPAIGN,
      links: [{ linkId: "L1", campaignId: "C1", createdAt: at }],
      socialPosts: [],
      contentPosts: [],
      brief: null,
      draft: null,
    });
    const result = await callTool("get_campaign", { campaign_id: "C1" });
    expect(campaignDomain.assertCampaignOwned).toHaveBeenCalledWith("C1", SUB);
    expect(result.structuredContent.campaign.campaign_id).toBe("C1");
    expect(result.structuredContent.links).toHaveLength(1);
  });

  test("update_campaign_status refuses a move the lifecycle does not allow", async () => {
    campaignDomain.assertCampaignOwned.mockResolvedValue({ ...CAMPAIGN, status: "draft" });
    const result = await callTool("update_campaign_status", { campaign_id: "C1", status: "completed" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Cannot move a campaign from draft to completed. Allowed from draft: active.");
    expect(campaignDomain.updateCampaignFields).not.toHaveBeenCalled();
  });

  test("update_campaign_status describes the lifecycle to the model", async () => {
    const { rpc } = mcpClient(handler);
    const { body } = await rpc({ method: "tools/list" });
    const tool = body.result.tools.find((t) => t.name === "update_campaign_status");
    expect(tool.description).toContain("completed -> nothing (final)");
  });

  test("update_campaign applies edits and rejects an empty change", async () => {
    campaignDomain.updateCampaignFields.mockResolvedValue({ ...CAMPAIGN, name: "Renamed" });
    const ok = await callTool("update_campaign", { campaign_id: "C1", name: "Renamed", endDate: "2026-12-31" });
    expect(campaignDomain.updateCampaignFields).toHaveBeenCalledWith("C1", { name: "Renamed", endDate: "2026-12-31" });
    expect(ok.structuredContent.campaign.name).toBe("Renamed");

    const empty = await callTool("update_campaign", { campaign_id: "C1" });
    expect(empty.isError).toBe(true);
  });

  test("update_campaign_payout marking unpaid clears paid_at", async () => {
    campaignDomain.updateCampaignPayout.mockResolvedValue(CAMPAIGN);
    await callTool("update_campaign_payout", { campaign_id: "C1", paid: false });
    expect(campaignDomain.updateCampaignPayout).toHaveBeenCalledWith("C1", { paid: false, paid_at: null });
  });
});

describe("vendor tools", () => {
  test("get_vendor returns the vendor with its campaigns", async () => {
    vendorDomain.assertVendorOwned.mockResolvedValue({ vendorId: "acme", name: "Acme", createdAt: at, updatedAt: at });
    vendorDomain.listCampaignsForVendor.mockResolvedValue([{ campaignId: "C1", name: "Launch", status: "active", createdAt: at }]);
    const result = await callTool("get_vendor", { vendor_id: "acme" });
    expect(vendorDomain.listCampaignsForVendor).toHaveBeenCalledWith("acme", SUB);
    expect(result.structuredContent.vendor.vendor_id).toBe("acme");
    expect(result.structuredContent.campaigns[0].campaign_id).toBe("C1");
  });

  test("get_vendor reports a foreign vendor as not found", async () => {
    vendorDomain.assertVendorOwned.mockRejectedValue(new NotFoundError("Vendor", "other"));
    const result = await callTool("get_vendor", { vendor_id: "other" });
    expect(result.isError).toBe(true);
    expect(vendorDomain.listCampaignsForVendor).not.toHaveBeenCalled();
  });

  test("create_vendor stamps the tenant and honors an idempotency key", async () => {
    vendorDomain.createVendor.mockResolvedValue({ vendorId: "acme", name: "Acme", createdAt: at, updatedAt: at });
    await callTool("create_vendor", { name: "Acme", vendor_id: "acme", idempotency_key: "v1" });
    expect(vendorDomain.createVendor).toHaveBeenCalledWith(expect.objectContaining({ name: "Acme", tenantId: SUB }));
    expect(keyed).toEqual([expect.objectContaining({ operation: "create_vendor", idempotencyKey: "v1" })]);
  });

  test("update_vendor checks ownership before writing", async () => {
    vendorDomain.updateVendor.mockResolvedValue({ vendorId: "acme", name: "Acme Co", createdAt: at, updatedAt: at });
    await callTool("update_vendor", { vendor_id: "acme", name: "Acme Co" });
    expect(vendorDomain.assertVendorOwned).toHaveBeenCalledWith("acme", SUB);
    expect(vendorDomain.updateVendor).toHaveBeenCalledWith("acme", expect.objectContaining({ name: "Acme Co" }));
  });
});

describe("deliverable tools", () => {
  test("add_campaign_link checks ownership, then mints the link", async () => {
    linkDomain.createLink.mockResolvedValue({ linkId: "L1", campaignId: "C1", createdAt: at });
    const result = await callTool("add_campaign_link", {
      campaign_id: "C1",
      role: "main",
      platform: "blog",
      url: "https://example.com/post",
      idempotency_key: "l1",
    });
    expect(campaignDomain.assertCampaignOwned).toHaveBeenCalledWith("C1", SUB);
    expect(linkDomain.createLink).toHaveBeenCalledWith("C1", expect.objectContaining({ role: "main", platform: "blog" }));
    expect(keyed[0].operation).toBe("add_campaign_link#C1");
    expect(result.structuredContent.link.campaign_id).toBe("C1");
  });

  test("a foreign campaign never reaches the link domain", async () => {
    campaignDomain.assertCampaignOwned.mockRejectedValue(new NotFoundError("Campaign", "C9"));
    const result = await callTool("add_campaign_link", {
      campaign_id: "C9",
      role: "main",
      platform: "blog",
      url: "https://example.com/post",
    });
    expect(result.isError).toBe(true);
    expect(linkDomain.createLink).not.toHaveBeenCalled();
  });

  test("update_campaign_link edits notes only", async () => {
    linkDomain.updateLink.mockResolvedValue({ linkId: "L1", campaignId: "C1", createdAt: at });
    await callTool("update_campaign_link", { campaign_id: "C1", link_id: "L1", notes: "pinned" });
    expect(linkDomain.updateLink).toHaveBeenCalledWith("C1", "L1", { notes: "pinned" });
  });

  test("update_campaign_link does not offer src or expiry, which newsletter-service owns", async () => {
    const { rpc } = mcpClient(handler);
    const { body } = await rpc({ method: "tools/list" });
    const tool = body.result.tools.find((t) => t.name === "update_campaign_link");
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["campaign_id", "link_id", "notes"]);

    linkDomain.updateLink.mockResolvedValue({ linkId: "L1", campaignId: "C1", createdAt: at });
    await callTool("update_campaign_link", { campaign_id: "C1", link_id: "L1", notes: null, src: "x" });
    expect(linkDomain.updateLink).toHaveBeenCalledWith("C1", "L1", { notes: null });
  });

  test("delete tools report what they removed", async () => {
    const link = await callTool("delete_campaign_link", { campaign_id: "C1", link_id: "L1" });
    expect(linkDomain.deleteLink).toHaveBeenCalledWith("C1", "L1");
    expect(link.structuredContent).toEqual({ deleted: true, link_id: "L1" });

    await callTool("delete_social_post", { campaign_id: "C1", post_id: "P1" });
    expect(socialDomain.deleteSocialPost).toHaveBeenCalledWith("C1", "P1");
    await callTool("delete_content_post", { campaign_id: "C1", post_id: "P2" });
    expect(contentDomain.deleteContentPost).toHaveBeenCalledWith("C1", "P2");
  });

  test("add_social_post derives the platform from the URL", async () => {
    socialDomain.createSocialPost.mockResolvedValue({ postId: "P1", campaignId: "C1", createdAt: at });
    await callTool("add_social_post", { campaign_id: "C1", url: "https://www.linkedin.com/posts/abc" });
    expect(socialDomain.createSocialPost).toHaveBeenCalledWith("C1", expect.objectContaining({ platform: "linkedin" }));
  });

  test("record_social_post_metrics stores the numbers", async () => {
    socialDomain.updateSocialPostAnalytics.mockResolvedValue({ postId: "P1", campaignId: "C1", createdAt: at });
    await callTool("record_social_post_metrics", { campaign_id: "C1", post_id: "P1", metrics: { likes: 12 } });
    expect(socialDomain.updateSocialPostAnalytics).toHaveBeenCalledWith("C1", "P1", { metrics: { likes: 12 } });
  });

  test("record_content_post_metrics rejects an empty metrics map", async () => {
    const result = await callTool("record_content_post_metrics", { campaign_id: "C1", post_id: "P2", metrics: {} });
    expect(result.isError).toBe(true);
    expect(contentDomain.updateContentPostAnalytics).not.toHaveBeenCalled();
  });

  test("add_content_post stores the post", async () => {
    contentDomain.createContentPost.mockResolvedValue({ postId: "P2", campaignId: "C1", createdAt: at });
    await callTool("add_content_post", { campaign_id: "C1", url: "https://dev.to/me/post" });
    expect(contentDomain.createContentPost).toHaveBeenCalledWith("C1", expect.objectContaining({ platform: "devto" }));
  });
});

describe("workflow tools", () => {
  test("attach_campaign_brief turns text into a vendor message", async () => {
    briefPipeline.attachBrief.mockResolvedValue({ summary: "s", suggested_campaign: { name: "X" }, warnings: [] });
    const result = await callTool("attach_campaign_brief", { campaign_id: "C1", text: "Two posts in December." });
    expect(briefPipeline.attachBrief).toHaveBeenCalledWith({
      campaignId: "C1",
      tenantId: SUB,
      submission: { source_type: "chat", conversation: [{ role: "vendor", content: "Two posts in December." }] },
    });
    expect(result.structuredContent.suggested_campaign).toEqual({ name: "X" });
  });

  test("attach_campaign_brief needs exactly one of text or conversation", async () => {
    const neither = await callTool("attach_campaign_brief", { campaign_id: "C1" });
    expect(neither.isError).toBe(true);
    const both = await callTool("attach_campaign_brief", {
      campaign_id: "C1",
      text: "a",
      conversation: [{ role: "vendor", content: "b" }],
    });
    expect(both.isError).toBe(true);
    expect(briefPipeline.attachBrief).not.toHaveBeenCalled();
  });

  test("save_campaign_draft stores the Google Doc link", async () => {
    draftDomain.saveDraftForCampaign.mockResolvedValue({ url: "u", docId: "d", createdAt: at });
    const url = "https://docs.google.com/document/d/abc123/edit";
    await callTool("save_campaign_draft", { campaign_id: "C1", url });
    expect(draftDomain.saveDraftForCampaign).toHaveBeenCalledWith(expect.objectContaining({ campaignId: "C1", docId: "abc123" }));
  });

  test("review_campaign_draft runs the review", async () => {
    briefPipeline.reviewCampaignDraft.mockResolvedValue({ url: "u", review: { ok: true }, createdAt: at });
    const result = await callTool("review_campaign_draft", { campaign_id: "C1" });
    expect(briefPipeline.reviewCampaignDraft).toHaveBeenCalledWith("C1");
    expect(result.structuredContent.draft.review).toEqual({ ok: true });
  });
});

describe("reporting tools", () => {
  test("get_campaign_analytics returns the link click rollup", async () => {
    analytics.getCampaignAnalytics.mockResolvedValue({ link_count: 1, upstream_failures: 0, total_clicks: 5 });
    const result = await callTool("get_campaign_analytics", { campaign_id: "C1" });
    expect(result.structuredContent.total_clicks).toBe(5);
  });

  test("get_campaign_web_analytics passes the owned row and range", async () => {
    webAnalytics.loadCampaignWebAnalytics.mockResolvedValue({ campaign_id: "C1", deliverable_type: "blog" });
    await callTool("get_campaign_web_analytics", { campaign_id: "C1", startDate: "2026-10-01" });
    expect(webAnalytics.loadCampaignWebAnalytics).toHaveBeenCalledWith(CAMPAIGN, {
      startDate: "2026-10-01",
      endDate: undefined,
    });
  });

  test("generate_campaign_report builds the stable link on the request's host and stage", async () => {
    reports.generateCampaignReport.mockImplementation(async ({ latestUrlFor }) => ({
      reportId: "R1",
      url: "https://signed",
      latestUrl: latestUrlFor("tok"),
    }));
    const result = await callTool("generate_campaign_report", { campaign_id: "C1" });
    expect(result.structuredContent.latestUrl).toBe("https://api.example.com/v1/public/campaign-reports/tok");
  });

  test("list_campaign_reports returns retained reports", async () => {
    reports.listCampaignReports.mockResolvedValue({ latestUrl: null, reports: [{ reportId: "R1" }] });
    const result = await callTool("list_campaign_reports", { campaign_id: "C1" });
    expect(result.structuredContent).toEqual({ latest_url: null, reports: [{ reportId: "R1" }] });
  });
});
