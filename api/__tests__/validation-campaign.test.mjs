import { validateCampaignCreate, validateCampaignUpdate } from "../validation/campaign.mjs";
import { BadRequestError } from "../services/errors.mjs";

describe("validateCampaignCreate", () => {
  test("rejects non-object body", () => {
    expect(() => validateCampaignCreate(null)).toThrow(BadRequestError);
    expect(() => validateCampaignCreate([])).toThrow(BadRequestError);
    expect(() => validateCampaignCreate("hi")).toThrow(BadRequestError);
  });

  test("requires non-empty name", () => {
    expect(() => validateCampaignCreate({})).toThrow(/name is required/);
    expect(() => validateCampaignCreate({ name: "  " })).toThrow();
  });

  test("rejects name longer than 200 chars", () => {
    expect(() => validateCampaignCreate({ name: "x".repeat(201) })).toThrow(/exceeds 200/);
  });

  test("trims name", () => {
    expect(validateCampaignCreate({ name: "  hello  " }).name).toBe("hello");
  });

  test("rejects malformed vendor_id", () => {
    expect(() => validateCampaignCreate({ name: "ok", vendor_id: "has spaces" })).toThrow(/vendor_id/);
  });

  test("rejects unknown status", () => {
    expect(() => validateCampaignCreate({ name: "ok", status: "archived" })).toThrow(/status must be/);
  });

  test("defaults status to active", () => {
    expect(validateCampaignCreate({ name: "ok" }).status).toBe("active");
  });

  test("rejects malformed startDate", () => {
    expect(() => validateCampaignCreate({ name: "ok", startDate: "2026/01/01" })).toThrow(/YYYY-MM-DD/);
  });

  test("rejects targetMetrics not an object", () => {
    expect(() => validateCampaignCreate({ name: "ok", targetMetrics: [1, 2] })).toThrow(/object/);
  });

  test("accepts a valid blog_url and maps it to blogUrl", () => {
    expect(validateCampaignCreate({ name: "ok", blog_url: "https://blog.example.com/my-post" }).blogUrl)
      .toBe("https://blog.example.com/my-post");
  });

  test("rejects a non-http(s) or malformed blog_url", () => {
    expect(() => validateCampaignCreate({ name: "ok", blog_url: "ftp://example.com" })).toThrow(/http/);
    expect(() => validateCampaignCreate({ name: "ok", blog_url: "not a url" })).toThrow(/valid absolute URL/);
  });

  test("treats empty-string blog_url as omitted", () => {
    expect(validateCampaignCreate({ name: "ok", blog_url: "" }).blogUrl).toBeUndefined();
  });

  test("accepts deliverable_type and maps it to deliverableType", () => {
    expect(validateCampaignCreate({ name: "ok", deliverable_type: "youtube" }).deliverableType)
      .toBe("youtube");
    expect(validateCampaignCreate({ name: "ok", deliverable_type: "blog" }).deliverableType)
      .toBe("blog");
  });

  test("rejects unknown deliverable_type", () => {
    expect(() => validateCampaignCreate({ name: "ok", deliverable_type: "tiktok" }))
      .toThrow(/deliverable_type must be one of/);
  });

  test("omits deliverable_type when not provided (defaulted at the read layer)", () => {
    expect(validateCampaignCreate({ name: "ok" }).deliverableType).toBeUndefined();
  });

  test("accepts a valid youtube_url and maps it to youtubeUrl", () => {
    expect(validateCampaignCreate({ name: "ok", youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }).youtubeUrl)
      .toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(validateCampaignCreate({ name: "ok", youtube_url: "https://youtu.be/dQw4w9WgXcQ" }).youtubeUrl)
      .toBe("https://youtu.be/dQw4w9WgXcQ");
  });

  test("rejects a non-YouTube or malformed youtube_url", () => {
    expect(() => validateCampaignCreate({ name: "ok", youtube_url: "https://example.com/watch?v=x" }))
      .toThrow(/valid YouTube video URL/);
    expect(() => validateCampaignCreate({ name: "ok", youtube_url: "not a url" }))
      .toThrow(/valid YouTube video URL/);
  });

  test("treats empty-string youtube_url as omitted", () => {
    expect(validateCampaignCreate({ name: "ok", youtube_url: "" }).youtubeUrl).toBeUndefined();
  });

  test("accepts a valid link_tracking_id and maps it to linkTrackingId", () => {
    expect(validateCampaignCreate({ name: "ok", link_tracking_id: "acme-q2_launch" }).linkTrackingId)
      .toBe("acme-q2_launch");
  });

  test("rejects link_tracking_id with disallowed characters", () => {
    expect(() => validateCampaignCreate({ name: "ok", link_tracking_id: "has spaces" }))
      .toThrow(/link_tracking_id/);
  });

  test("treats empty-string link_tracking_id as omitted", () => {
    expect(validateCampaignCreate({ name: "ok", link_tracking_id: "" }).linkTrackingId)
      .toBeUndefined();
  });

  test("happy path with all fields", () => {
    const out = validateCampaignCreate({
      name: "Q2 push",
      sponsor: "Acme",
      vendor_id: "01HV0AABBCCDDEEFFGGHHJJKKM",
      startDate: "2026-04-01",
      endDate: "2026-06-30",
      status: "draft",
      targetMetrics: { impressions: 50000 },
      blog_url: "https://blog.example.com/q2",
      link_tracking_id: "acme-q2-launch",
    });
    expect(out).toEqual({
      name: "Q2 push",
      sponsor: "Acme",
      vendorId: "01HV0AABBCCDDEEFFGGHHJJKKM",
      startDate: "2026-04-01",
      endDate: "2026-06-30",
      status: "draft",
      targetMetrics: { impressions: 50000 },
      blogUrl: "https://blog.example.com/q2",
      linkTrackingId: "acme-q2-launch",
    });
  });
});

describe("validateCampaignUpdate", () => {
  test("rejects non-object body", () => {
    expect(() => validateCampaignUpdate(null)).toThrow(BadRequestError);
    expect(() => validateCampaignUpdate([])).toThrow(BadRequestError);
  });

  test("empty body is a valid no-op", () => {
    expect(validateCampaignUpdate({})).toEqual({});
  });

  test("only includes provided fields (partial)", () => {
    expect(validateCampaignUpdate({ startDate: "2026-06-01" })).toEqual({ startDate: "2026-06-01" });
  });

  test("rejects empty name when present", () => {
    expect(() => validateCampaignUpdate({ name: "  " })).toThrow(/non-empty/);
  });

  test("trims name", () => {
    expect(validateCampaignUpdate({ name: "  hi  " }).name).toBe("hi");
  });

  test("rejects bad status and date", () => {
    expect(() => validateCampaignUpdate({ status: "live" })).toThrow(/status/);
    expect(() => validateCampaignUpdate({ startDate: "2026/06/01" })).toThrow(/YYYY-MM-DD/);
  });

  test("normalizes payout to a full object", () => {
    const out = validateCampaignUpdate({ payout: { amount: 1500, currency: "USD", paid: true } });
    expect(out.payout).toEqual({ amount: 1500, currency: "USD", paid: true });
  });

  test("rejects malformed payout", () => {
    expect(() => validateCampaignUpdate({ payout: { amount: -1 } })).toThrow(/amount/);
    expect(() => validateCampaignUpdate({ payout: { amount: 10, currency: "usd" } })).toThrow(/ISO 4217/);
  });

  test("treats empty-string dates as omitted", () => {
    expect(validateCampaignUpdate({ startDate: "", endDate: "" })).toEqual({});
  });

  test("accepts and validates blog_url", () => {
    expect(validateCampaignUpdate({ blog_url: "https://example.com/post" }))
      .toEqual({ blogUrl: "https://example.com/post" });
    expect(() => validateCampaignUpdate({ blog_url: "javascript:alert(1)" })).toThrow();
  });

  test("accepts and validates link_tracking_id", () => {
    expect(validateCampaignUpdate({ link_tracking_id: "acme-q2" }))
      .toEqual({ linkTrackingId: "acme-q2" });
    expect(() => validateCampaignUpdate({ link_tracking_id: "has spaces" })).toThrow();
  });

  test("accepts and validates deliverable_type", () => {
    expect(validateCampaignUpdate({ deliverable_type: "youtube" }))
      .toEqual({ deliverableType: "youtube" });
    expect(() => validateCampaignUpdate({ deliverable_type: "tiktok" }))
      .toThrow(/deliverable_type must be one of/);
  });

  test("accepts and validates youtube_url", () => {
    expect(validateCampaignUpdate({ youtube_url: "https://www.youtube.com/shorts/dQw4w9WgXcQ" }))
      .toEqual({ youtubeUrl: "https://www.youtube.com/shorts/dQw4w9WgXcQ" });
    expect(() => validateCampaignUpdate({ youtube_url: "https://vimeo.com/12345" })).toThrow();
  });

  test("accepts vendor_id and maps it to vendorId", () => {
    expect(validateCampaignUpdate({ vendor_id: "acme_co" })).toEqual({ vendorId: "acme_co" });
  });

  test("rejects malformed vendor_id", () => {
    expect(() => validateCampaignUpdate({ vendor_id: "has spaces" })).toThrow(/vendor_id/);
  });

  test("ignores null vendor_id", () => {
    expect(validateCampaignUpdate({ vendor_id: null })).toEqual({});
  });
});
