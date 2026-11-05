import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

const { autoMock } = await import("./test-support.mjs");
const mockDomain = (path) => jest.unstable_mockModule(path, autoMock(path, import.meta.url));
mockDomain("../../api/domain/campaign.mjs");
mockDomain("../../api/domain/vendor.mjs");
mockDomain("../../api/domain/link.mjs");
mockDomain("../../api/domain/social-post.mjs");
mockDomain("../../api/domain/content-post.mjs");
mockDomain("../../api/domain/draft.mjs");
mockDomain("../../api/services/activity.mjs");
mockDomain("../../api/services/brief-pipeline.mjs");
mockDomain("../../api/services/campaign-analytics.mjs");
mockDomain("../../api/services/campaign-reports.mjs");
mockDomain("../../api/services/campaign-web-analytics.mjs");
const keyedCalls = [];
jest.unstable_mockModule("../../api/services/idempotency.mjs", () => ({
  runOnce: (args) => {
    if (args.idempotencyKey) keyedCalls.push(args);
    return args.run();
  },
}));

const campaignDomain = await import("../../api/domain/campaign.mjs");
const vendorDomain = await import("../../api/domain/vendor.mjs");
const { trackActivity } = await import("../../api/services/activity.mjs");
const { NotFoundError } = await import("../../api/services/errors.mjs");
const { handler } = await import("./index.mjs");

const { SUB, VERSION, mcpClient, rpcEvent: event } = await import("./test-support.mjs");
const { rpc, callTool: call } = mcpClient(handler);
const callTool = async (name, args) => ({ body: { result: await call(name, args) } });

const row = (overrides = {}) => ({
  campaignId: "01J0000000000000000000000C",
  name: "Launch",
  status: "active",
  createdAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  keyedCalls.length = 0;
  campaignDomain.assertCampaignOwned.mockResolvedValue(row({ payout: { amount: 500, currency: "USD" } }));
});

describe("mcp transport", () => {
  test("server/discover advertises the 2026-07-28 revision and tools", async () => {
    const { status, body } = await rpc({ method: "server/discover" });
    expect(status).toBe(200);
    expect(body.result.supportedVersions).toContain(VERSION);
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("booked");
  });

  test("tools/list exposes the campaign tools", async () => {
    const { body } = await rpc({ method: "tools/list" });
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "add_campaign_link",
      "add_content_post",
      "add_social_post",
      "attach_campaign_brief",
      "create_campaign",
      "create_vendor",
      "delete_campaign_link",
      "delete_content_post",
      "delete_social_post",
      "generate_campaign_report",
      "get_campaign",
      "get_campaign_analytics",
      "get_campaign_web_analytics",
      "get_vendor",
      "list_campaign_reports",
      "list_campaigns",
      "list_vendors",
      "mark_campaign_paid",
      "record_content_post_metrics",
      "record_social_post_metrics",
      "review_campaign_draft",
      "save_campaign_draft",
      "update_campaign",
      "update_campaign_link",
      "update_campaign_payout",
      "update_campaign_status",
      "update_vendor",
    ]);
  });

  test("every tool declares annotations, and deletes are marked destructive", async () => {
    const { body } = await rpc({ method: "tools/list" });
    for (const tool of body.result.tools) {
      expect(tool.annotations).toBeDefined();
      expect(tool.annotations.destructiveHint === true).toBe(tool.name.startsWith("delete_"));
    }
  });

  test("rejects the Chrome extension auth source with 401", async () => {
    const res = await handler(event({ method: "tools/list", authSource: "extension" }));
    expect(res.statusCode).toBe(401);
  });

  test("rejects browser origins with 403", async () => {
    const res = await handler(event({ method: "tools/list", headers: { Origin: "https://evil.example" } }));
    expect(res.statusCode).toBe(403);
  });

  test("rejects an Mcp-Name header that disagrees with the body", async () => {
    const res = await handler(
      event({ method: "tools/call", name: "list_vendors", params: { name: "list_campaigns", arguments: {} } }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32020);
  });

  test("serves a 2025-era initialize through the stateless fallback", async () => {
    const res = await handler(
      event({
        method: "initialize",
        headers: { "MCP-Protocol-Version": "2025-11-25" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old", version: "1" } },
        }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"protocolVersion":"2025-11-25"');
  });
});

describe("create_campaign", () => {
  test("creates in the caller's tenant and returns the formatted campaign", async () => {
    campaignDomain.createCampaign.mockResolvedValue(row());
    const { body } = await callTool("create_campaign", { name: "Launch", startDate: "2026-12-01" });
    expect(campaignDomain.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Launch", startDate: "2026-12-01", status: "active", tenantId: SUB }),
    );
    expect(trackActivity).toHaveBeenCalledWith(SUB, "campaign.created", expect.any(Object));
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.campaign).toMatchObject({ name: "Launch", status: "active" });
  });

  test("checks vendor ownership and normalizes the payout", async () => {
    campaignDomain.createCampaign.mockResolvedValue(row());
    await callTool("create_campaign", { name: "Deal", vendor_id: "acme", payout: { amount: 2000 } });
    expect(vendorDomain.assertVendorOwned).toHaveBeenCalledWith("acme", SUB);
    expect(campaignDomain.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ payout: expect.objectContaining({ amount: 2000, currency: "USD", paid: false }) }),
    );
  });

  test("routes through keyed idempotency only when a key is supplied", async () => {
    campaignDomain.createCampaign.mockResolvedValue(row());
    await callTool("create_campaign", { name: "Once" });
    expect(keyedCalls).toHaveLength(0);
    await callTool("create_campaign", { name: "Once", idempotency_key: "k-1" });
    expect(keyedCalls).toEqual([
      expect.objectContaining({ operation: "create_campaign", tenantId: SUB, idempotencyKey: "k-1" }),
    ]);
  });

  test("returns validation failures as a tool error", async () => {
    const { body } = await callTool("create_campaign", { name: "Bad", startDate: "12/01/2026" });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/startDate must be YYYY-MM-DD/);
    expect(campaignDomain.createCampaign).not.toHaveBeenCalled();
  });

  test("hides unexpected errors behind a generic message", async () => {
    campaignDomain.createCampaign.mockRejectedValue(new Error("ddb exploded: secret detail"));
    const { body } = await callTool("create_campaign", { name: "Boom" });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe("Internal error. Try again later.");
  });
});

describe("update_campaign_status", () => {
  test("checks ownership then updates the status", async () => {
    campaignDomain.assertCampaignOwned.mockResolvedValue(row({ status: "monitoring" }));
    campaignDomain.updateCampaignFields.mockResolvedValue(row({ status: "completed" }));
    const { body } = await callTool("update_campaign_status", { campaign_id: "C1", status: "completed" });
    expect(campaignDomain.assertCampaignOwned).toHaveBeenCalledWith("C1", SUB);
    expect(campaignDomain.updateCampaignFields).toHaveBeenCalledWith("C1", { status: "completed" });
    expect(body.result.structuredContent.campaign.status).toBe("completed");
  });

  test("reports a foreign or missing campaign as not found", async () => {
    campaignDomain.assertCampaignOwned.mockRejectedValue(new NotFoundError("Campaign", "C9"));
    const { body } = await callTool("update_campaign_status", { campaign_id: "C9", status: "active" });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe("Campaign C9 not found");
    expect(campaignDomain.updateCampaignFields).not.toHaveBeenCalled();
  });

  test("rejects an unknown status before touching data", async () => {
    const { body } = await callTool("update_campaign_status", { campaign_id: "C1", status: "archived" });
    expect(body.result.isError).toBe(true);
    expect(campaignDomain.assertCampaignOwned).not.toHaveBeenCalled();
  });
});

describe("mark_campaign_paid", () => {
  test("marks paid with today's date by default", async () => {
    campaignDomain.updateCampaignPayout.mockResolvedValue(row({ payout: { amount: 500, currency: "USD", paid: true } }));
    const today = new Date().toISOString().slice(0, 10);
    await callTool("mark_campaign_paid", { campaign_id: "C1", invoice_ref: "INV-7" });
    expect(campaignDomain.updateCampaignPayout).toHaveBeenCalledWith("C1", {
      paid: true,
      paid_at: today,
      invoice_ref: "INV-7",
    });
  });

  test("refuses a campaign with no payout amount", async () => {
    campaignDomain.assertCampaignOwned.mockResolvedValue(row());
    const { body } = await callTool("mark_campaign_paid", { campaign_id: "C1" });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/no payout amount/);
    expect(campaignDomain.updateCampaignPayout).not.toHaveBeenCalled();
  });

  test("records an amount supplied alongside the payment", async () => {
    campaignDomain.assertCampaignOwned.mockResolvedValue(row());
    campaignDomain.updateCampaignPayout.mockResolvedValue(row({ payout: { amount: 750, currency: "USD", paid: true } }));
    await callTool("mark_campaign_paid", { campaign_id: "C1", amount: 750, paid_at: "2026-11-02" });
    expect(campaignDomain.updateCampaignPayout).toHaveBeenCalledWith("C1", {
      paid: true,
      paid_at: "2026-11-02",
      amount: 750,
      currency: "USD",
    });
  });
});

describe("list tools", () => {
  test("list_campaigns scopes to the tenant and returns a cursor", async () => {
    campaignDomain.listCampaigns.mockResolvedValue({ items: [row()], lastEvaluatedKey: { pk: "x" } });
    const { body } = await callTool("list_campaigns", { status: "active", limit: 10 });
    expect(campaignDomain.listCampaigns).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: SUB, status: "active", limit: 10 }),
    );
    expect(body.result.structuredContent.campaigns).toHaveLength(1);
    expect(body.result.structuredContent.next_cursor).toEqual(expect.any(String));
  });

  test("list_vendors scopes to the tenant", async () => {
    vendorDomain.listVendors.mockResolvedValue({
      items: [{ vendorId: "acme", name: "Acme", createdAt: "x", updatedAt: "x" }],
      lastEvaluatedKey: undefined,
    });
    const { body } = await callTool("list_vendors", {});
    expect(vendorDomain.listVendors).toHaveBeenCalledWith(expect.objectContaining({ tenantId: SUB }));
    expect(body.result.structuredContent).toEqual({
      vendors: [expect.objectContaining({ vendor_id: "acme", name: "Acme" })],
      next_cursor: null,
    });
  });
});
