import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../services/bedrock/brief.mjs", () => ({ reviewDraft: jest.fn(), summarizeBrief: jest.fn() }));
jest.unstable_mockModule("../services/google-docs.mjs", () => ({ extractGoogleDocId: jest.fn(), fetchGoogleDocText: jest.fn() }));
jest.unstable_mockModule("../services/s3.mjs", () => ({
  briefFileKey: (campaignId, format) => `uploads/${campaignId}.${format}`,
  getBriefObjectBytes: jest.fn(),
  moveBriefObject: jest.fn(),
  presignStagedBriefUpload: jest.fn(),
  putBriefTranscript: jest.fn(),
  stagedBriefKey: (tenantId, uploadId, format) => `staged/${tenantId}/${uploadId}.${format}`,
}));
jest.unstable_mockModule("../domain/campaign.mjs", () => ({ createCampaign: jest.fn(), findCampaign: jest.fn() }));
jest.unstable_mockModule("../domain/vendor.mjs", () => ({ listVendors: jest.fn() }));
jest.unstable_mockModule("../domain/brief.mjs", () => ({
  getBriefForCampaign: jest.fn(),
  saveBriefForCampaign: jest.fn(),
}));
jest.unstable_mockModule("../domain/draft.mjs", () => ({ getDraftForCampaign: jest.fn(), saveDraftReview: jest.fn() }));

const { summarizeBrief } = await import("../services/bedrock/brief.mjs");
const { getBriefObjectBytes, moveBriefObject, presignStagedBriefUpload } = await import("../services/s3.mjs");
const { createCampaign, findCampaign } = await import("../domain/campaign.mjs");
const { listVendors } = await import("../domain/vendor.mjs");
const { saveBriefForCampaign } = await import("../domain/brief.mjs");
const { BadRequestError } = await import("../services/errors.mjs");
const { attachBrief, createCampaignFromBrief, stageBriefUpload } = await import("../services/brief-pipeline.mjs");

const TENANT = "tenant-1";
const UPLOAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BYTES = Buffer.from("brief");

const input = (overrides = {}) => ({ tenantId: TENANT, uploadId: UPLOAD_ID, sourceType: "pdf", fileName: "Acme deal.pdf", ...overrides });

beforeEach(() => {
  jest.clearAllMocks();
  getBriefObjectBytes.mockResolvedValue(BYTES);
  listVendors.mockResolvedValue({ items: [{ vendorId: "acme", name: "Acme" }] });
  createCampaign.mockResolvedValue({ campaignId: "C1", name: "Acme launch" });
  summarizeBrief.mockResolvedValue({
    summary: "A sponsored post.",
    suggested_campaign: {
      name: "Acme launch",
      vendor: { vendor_id: "acme", name_hint: "Acme" },
      startDate: "2026-12-01",
      payout: { amount: 5000, currency: "USD" },
    },
    warnings: ["No end date."],
  });
});

describe("stageBriefUpload", () => {
  test("mints a tenant-scoped upload with a fresh id", async () => {
    presignStagedBriefUpload.mockResolvedValue({ url: "https://s3/put", key: "k", expiresAt: "soon" });

    const result = await stageBriefUpload({ tenantId: TENANT, format: "docx", contentType: "x" });

    expect(result.url).toBe("https://s3/put");
    expect(presignStagedBriefUpload).toHaveBeenCalledWith({
      tenantId: TENANT,
      uploadId: result.uploadId,
      format: "docx",
      contentType: "x",
    });
  });
});

describe("createCampaignFromBrief", () => {
  test("reads the tenant's staged file", async () => {
    await createCampaignFromBrief(input({ sourceType: "docx" }));

    expect(getBriefObjectBytes).toHaveBeenCalledWith(`staged/${TENANT}/${UPLOAD_ID}.docx`);
    expect(summarizeBrief).toHaveBeenCalledWith({
      sourceType: "docx",
      documentBytes: BYTES,
      vendors: [{ vendorId: "acme", name: "Acme" }],
    });
  });

  test("saves name, sponsor, and vendor, and leaves dates and payout for review", async () => {
    await createCampaignFromBrief(input());

    const fields = createCampaign.mock.calls[0][0];
    expect(fields).toMatchObject({ name: "Acme launch", sponsor: "Acme", vendorId: "acme", tenantId: TENANT });
    expect(fields).not.toHaveProperty("startDate");
    expect(fields).not.toHaveProperty("payout");
  });

  test("moves the file and stores the brief under the new campaign", async () => {
    await createCampaignFromBrief(input());

    expect(moveBriefObject).toHaveBeenCalledWith({
      from: `staged/${TENANT}/${UPLOAD_ID}.pdf`,
      to: "uploads/C1.pdf",
    });
    expect(saveBriefForCampaign).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "C1",
      sourceType: "pdf",
      s3Key: "uploads/C1.pdf",
      summary: "A sponsored post.",
      warnings: ["No end date."],
    }));
  });

  test("drops a vendor id the model made up", async () => {
    summarizeBrief.mockResolvedValue({
      summary: "s",
      suggested_campaign: { name: "N", vendor: { vendor_id: "ghost", name_hint: "Ghost" } },
    });

    await createCampaignFromBrief(input());

    const fields = createCampaign.mock.calls[0][0];
    expect(fields).not.toHaveProperty("vendorId");
    expect(fields.sponsor).toBe("Ghost");
    expect(saveBriefForCampaign.mock.calls[0][0].suggestedCampaign.vendor).toEqual({ name_hint: "Ghost" });
  });

  test("falls back to the file name when the model gives no name", async () => {
    summarizeBrief.mockResolvedValue({ summary: "s", suggested_campaign: {} });

    await createCampaignFromBrief(input());

    expect(createCampaign.mock.calls[0][0].name).toBe("Acme deal");
  });

  test("creates nothing when the model fails", async () => {
    summarizeBrief.mockRejectedValue(new Error("model down"));

    await expect(createCampaignFromBrief(input())).rejects.toThrow("model down");
    expect(createCampaign).not.toHaveBeenCalled();
  });

  test("creates nothing when the file was never uploaded", async () => {
    getBriefObjectBytes.mockRejectedValue(new Error("NoSuchKey"));

    await expect(createCampaignFromBrief(input())).rejects.toThrow(BadRequestError);
    expect(createCampaign).not.toHaveBeenCalled();
  });

  test("still returns the campaign when saving the brief fails, so a retry can't duplicate it", async () => {
    moveBriefObject.mockRejectedValue(new Error("S3 down"));

    await expect(createCampaignFromBrief(input())).resolves.toMatchObject({ campaignId: "C1" });
  });
});

describe("attachBrief", () => {
  test("reads a Word file from its own key", async () => {
    findCampaign.mockResolvedValue({ campaignId: "C1" });

    await attachBrief({ campaignId: "C1", tenantId: TENANT, submission: { source_type: "docx" } });

    expect(getBriefObjectBytes).toHaveBeenCalledWith("uploads/C1.docx");
    expect(summarizeBrief.mock.calls[0][0]).toMatchObject({ sourceType: "docx", documentBytes: BYTES });
    expect(saveBriefForCampaign.mock.calls[0][0]).toMatchObject({ s3Key: "uploads/C1.docx", sourceType: "docx" });
  });

  test("drops a vendor id the model made up", async () => {
    findCampaign.mockResolvedValue({ campaignId: "C1" });
    summarizeBrief.mockResolvedValue({ summary: "s", suggested_campaign: { name: "N", vendor: { vendor_id: "ghost" } } });

    const result = await attachBrief({ campaignId: "C1", tenantId: TENANT, submission: { source_type: "pdf" } });

    expect(result.suggested_campaign.vendor).toEqual({});
  });
});
