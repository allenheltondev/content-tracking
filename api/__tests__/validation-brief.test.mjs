import {
  conversationToTranscript,
  validateBriefConfirm,
  validateBriefSubmission,
  validateUploadUrlRequest,
} from "../validation/brief.mjs";
import { BadRequestError } from "../services/errors.mjs";

const VALID_VENDOR_ID = "01HV0AABBCCDDEEFFGGHHJJKKM";

describe("validateUploadUrlRequest", () => {
  test("accepts empty body", () => {
    expect(validateUploadUrlRequest({})).toEqual({ content_type: "application/pdf" });
    expect(validateUploadUrlRequest(undefined)).toEqual({});
  });

  test("rejects non-pdf content_type", () => {
    expect(() => validateUploadUrlRequest({ content_type: "image/png" })).toThrow(BadRequestError);
  });

  test("accepts explicit application/pdf", () => {
    expect(validateUploadUrlRequest({ content_type: "application/pdf" })).toEqual({
      content_type: "application/pdf",
    });
  });
});

describe("validateBriefSubmission", () => {
  test("rejects unknown source_type", () => {
    expect(() => validateBriefSubmission({ source_type: "audio" })).toThrow(BadRequestError);
    expect(() => validateBriefSubmission({})).toThrow(/source_type/);
  });

  describe("chat", () => {
    test("requires non-empty conversation", () => {
      expect(() =>
        validateBriefSubmission({ source_type: "chat", conversation: [] }),
      ).toThrow(/non-empty/);
    });

    test("rejects bad role", () => {
      expect(() =>
        validateBriefSubmission({
          source_type: "chat",
          conversation: [{ role: "robot", content: "hi" }],
        }),
      ).toThrow(/role/);
    });

    test("rejects empty content", () => {
      expect(() =>
        validateBriefSubmission({
          source_type: "chat",
          conversation: [{ role: "vendor", content: "" }],
        }),
      ).toThrow(/content/);
    });

    test("happy path normalizes shape", () => {
      const out = validateBriefSubmission({
        source_type: "chat",
        conversation: [
          { role: "vendor", content: "Looking for an IG reel" },
          { role: "influencer", content: "Sounds good, what's the budget?" },
        ],
      });
      expect(out.source_type).toBe("chat");
      expect(out.conversation.length).toBe(2);
    });
  });

  describe("pdf", () => {
    test("requires ULID brief_id", () => {
      expect(() =>
        validateBriefSubmission({ source_type: "pdf", brief_id: "abc" }),
      ).toThrow(/ULID/);
    });

    test("happy path", () => {
      expect(
        validateBriefSubmission({
          source_type: "pdf",
          brief_id: "01HV0AABBCCDDEEFFGGHHJJKKM",
        }),
      ).toEqual({ source_type: "pdf", brief_id: "01HV0AABBCCDDEEFFGGHHJJKKM" });
    });
  });
});

describe("validateBriefConfirm", () => {
  test("rejects non-object body", () => {
    expect(() => validateBriefConfirm(null)).toThrow(BadRequestError);
    expect(() => validateBriefConfirm([])).toThrow(BadRequestError);
  });

  test("requires name", () => {
    expect(() => validateBriefConfirm({})).toThrow(/name is required/);
    expect(() => validateBriefConfirm({ name: "   " })).toThrow(/name is required/);
  });

  test("happy path with all fields", () => {
    const out = validateBriefConfirm({
      name: " My Campaign ",
      vendor_id: VALID_VENDOR_ID,
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      status: "active",
      targetMetrics: { impressions: 10000 },
      deliverables: [
        { platform: "instagram", type: "reel", count: 2, notes: "60s max" },
      ],
      payout: { amount: 1500, currency: "USD", paid: false },
    });
    expect(out.campaignFields.name).toBe("My Campaign");
    expect(out.campaignFields.vendorId).toBe(VALID_VENDOR_ID);
    expect(out.campaignFields.status).toBe("active");
    expect(out.campaignFields.startDate).toBe("2026-06-01");
    expect(out.campaignFields.targetMetrics).toEqual({ impressions: 10000 });
    expect(out.acceptedSuggestion.deliverables).toEqual([
      { platform: "instagram", type: "reel", count: 2, notes: "60s max" },
    ]);
    expect(out.acceptedSuggestion.payout).toEqual({ amount: 1500, currency: "USD" });
    expect(out.payout).toEqual({ amount: 1500, currency: "USD", paid: false });
  });

  test("defaults status to draft when omitted", () => {
    const out = validateBriefConfirm({ name: "Bare" });
    expect(out.campaignFields.status).toBe("draft");
  });

  test("accepts free-text sponsor without vendor_id", () => {
    const out = validateBriefConfirm({ name: "X", sponsor: "Acme Corp" });
    expect(out.campaignFields.sponsor).toBe("Acme Corp");
    expect(out.acceptedSuggestion.vendor.name_hint).toBe("Acme Corp");
    expect(out.campaignFields.vendorId).toBeUndefined();
  });

  test("rejects non-ULID vendor_id", () => {
    expect(() => validateBriefConfirm({ name: "X", vendor_id: "abc" })).toThrow(/ULID/);
  });

  test("rejects bad status", () => {
    expect(() => validateBriefConfirm({ name: "X", status: "live" })).toThrow(/status/);
  });

  test("rejects bad date format", () => {
    expect(() => validateBriefConfirm({ name: "X", startDate: "2026/06/01" })).toThrow(/startDate/);
  });

  test("rejects malformed deliverable", () => {
    expect(() =>
      validateBriefConfirm({ name: "X", deliverables: [{ platform: "instagram" }] }),
    ).toThrow(/type/);
    expect(() =>
      validateBriefConfirm({ name: "X", deliverables: [{ platform: "", type: "reel" }] }),
    ).toThrow(/platform/);
    expect(() =>
      validateBriefConfirm({ name: "X", deliverables: [{ platform: "x", type: "post", count: 0 }] }),
    ).toThrow(/count/);
  });

  test("rejects malformed payout", () => {
    expect(() =>
      validateBriefConfirm({ name: "X", payout: { amount: -1, currency: "USD" } }),
    ).toThrow(/amount/);
    expect(() =>
      validateBriefConfirm({ name: "X", payout: { amount: 100, currency: "usd" } }),
    ).toThrow(/ISO 4217/);
  });

  test("omits deliverables when not provided", () => {
    const out = validateBriefConfirm({ name: "X" });
    expect(out.acceptedSuggestion.deliverables).toBeUndefined();
  });

  test("treats empty string fields as omitted", () => {
    const out = validateBriefConfirm({ name: "X", startDate: "", endDate: "", vendor_id: "", sponsor: "" });
    expect(out.campaignFields.startDate).toBeUndefined();
    expect(out.campaignFields.vendorId).toBeUndefined();
    expect(out.campaignFields.sponsor).toBeUndefined();
  });
});

describe("conversationToTranscript", () => {
  test("joins entries on double newline with role prefix", () => {
    expect(
      conversationToTranscript([
        { role: "vendor", content: "Brief intro" },
        { role: "influencer", content: "Got it" },
      ]),
    ).toBe("vendor: Brief intro\n\ninfluencer: Got it");
  });
});
