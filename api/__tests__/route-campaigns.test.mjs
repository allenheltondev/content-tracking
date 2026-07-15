import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

// Pass-through idempotency; mock the domain + the heavy Bedrock/S3/Docs
// collaborators (only touched by the brief/draft routes) so importing the
// campaign route module stays light and the create/patch auth wiring is
// exercised in isolation.
jest.unstable_mockModule("../services/idempotency.mjs", () => ({ withIdempotency: (fn) => fn }));
jest.unstable_mockModule("../services/activity.mjs", () => ({ trackActivity: jest.fn(), ACTIVITY_SERVICE: "booked" }));
jest.unstable_mockModule("../services/bedrock.mjs", () => ({ reviewDraft: jest.fn(), summarizeBrief: jest.fn() }));
jest.unstable_mockModule("../services/google-docs.mjs", () => ({ extractGoogleDocId: jest.fn(), fetchGoogleDocText: jest.fn() }));
jest.unstable_mockModule("../services/s3.mjs", () => ({
  getBriefObjectBytes: jest.fn(),
  presignBriefDownload: jest.fn(),
  presignBriefUpload: jest.fn(),
  putBriefTranscript: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  assertCampaignOwned: jest.fn(),
  createCampaign: jest.fn(),
  findCampaign: jest.fn(),
  getCampaignWithLinks: jest.fn(),
  listCampaigns: jest.fn(),
  updateCampaignFields: jest.fn(),
}));
jest.unstable_mockModule("../domain/vendor.mjs", () => ({
  assertVendorOwned: jest.fn(),
  listVendors: jest.fn(),
}));
jest.unstable_mockModule("../domain/brief.mjs", () => ({
  getBriefForCampaign: jest.fn(),
  saveBriefForCampaign: jest.fn(),
}));
jest.unstable_mockModule("../domain/draft.mjs", () => ({
  getDraftForCampaign: jest.fn(),
  saveDraftForCampaign: jest.fn(),
  saveDraftReview: jest.fn(),
}));

const { assertCampaignOwned, createCampaign, updateCampaignFields } = await import("../domain/campaign.mjs");
const { assertVendorOwned } = await import("../domain/vendor.mjs");
const { trackActivity } = await import("../services/activity.mjs");
const { NotFoundError } = await import("../services/errors.mjs");
const { registerCampaignRoutes } = await import("../routes/campaigns.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (p, h) => { routes[`GET ${p}`] = h; },
    post: (p, h) => { routes[`POST ${p}`] = h; },
    put: (p, h) => { routes[`PUT ${p}`] = h; },
    patch: (p, h) => { routes[`PATCH ${p}`] = h; },
    delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  };
  registerCampaignRoutes(app);
  return routes;
}
const routes = buildRouteTable();
const SUB = "user-1";
const VENDOR_ID = "acme-co";

function ctx({ body, params } = {}) {
  return {
    event: {
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: { authorizer: { authSource: "cognito", sub: SUB } },
    },
    params,
  };
}

describe("routes/campaigns — vendor ownership on link", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createCampaign.mockImplementation(async (fields) => ({ campaignId: "C1", ...fields }));
    updateCampaignFields.mockImplementation(async (id, fields) => ({ campaignId: id, ...fields }));
    assertCampaignOwned.mockResolvedValue({ campaignId: "C1", tenantId: SUB });
  });

  describe("POST /campaigns", () => {
    const post = () => routes["POST /campaigns"];

    test("verifies the vendor is the caller's before creating", async () => {
      assertVendorOwned.mockResolvedValue({ vendorId: VENDOR_ID, tenantId: SUB });
      const res = await post()(ctx({ body: { name: "Launch", vendor_id: VENDOR_ID } }));
      expect(res.statusCode).toBe(201);
      expect(assertVendorOwned).toHaveBeenCalledWith(VENDOR_ID, SUB);
      expect(createCampaign).toHaveBeenCalledWith(expect.objectContaining({ vendorId: VENDOR_ID, tenantId: SUB }));
    });

    test("404s a foreign/unknown vendor and never writes the campaign", async () => {
      assertVendorOwned.mockRejectedValue(new NotFoundError("Vendor", VENDOR_ID));
      await expect(post()(ctx({ body: { name: "Launch", vendor_id: VENDOR_ID } }))).rejects.toThrow(/Vendor .* not found/);
      expect(createCampaign).not.toHaveBeenCalled();
    });

    test("skips the vendor check when no vendor is supplied", async () => {
      const res = await post()(ctx({ body: { name: "Solo" } }));
      expect(res.statusCode).toBe(201);
      expect(assertVendorOwned).not.toHaveBeenCalled();
      // Emits the "Deal Maker" gamification activity, keyed for idempotency.
      expect(trackActivity).toHaveBeenCalledWith(SUB, "campaign.created", {
        id: `campaign.created#${SUB}#C1`,
      });
    });
  });

  describe("PATCH /campaigns/:campaignId", () => {
    const patch = () => routes["PATCH /campaigns/:campaignId"];

    test("verifies vendor ownership before re-linking", async () => {
      assertVendorOwned.mockResolvedValue({ vendorId: VENDOR_ID, tenantId: SUB });
      const res = await patch()(ctx({ body: { vendor_id: VENDOR_ID }, params: { campaignId: "C1" } }));
      expect(res.statusCode).toBe(200);
      expect(assertVendorOwned).toHaveBeenCalledWith(VENDOR_ID, SUB);
      expect(updateCampaignFields).toHaveBeenCalled();
    });

    test("404s a foreign vendor and never updates the campaign", async () => {
      assertVendorOwned.mockRejectedValue(new NotFoundError("Vendor", VENDOR_ID));
      await expect(patch()(ctx({ body: { vendor_id: VENDOR_ID }, params: { campaignId: "C1" } }))).rejects.toThrow(/Vendor .* not found/);
      expect(updateCampaignFields).not.toHaveBeenCalled();
    });
  });
});
