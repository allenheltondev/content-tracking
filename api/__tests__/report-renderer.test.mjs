import { describe, it, expect } from "@jest/globals";
import { renderVendorReportHtml } from "../services/report-renderer.mjs";

function sampleSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    report: {
      id: "rep_123",
      generatedAt: "2026-05-29T12:00:00.000Z",
      dataAsOf: "2026-05-28",
      period: { startDate: "2026-01-01", endDate: "2026-05-28", label: "Jan – May 2026" },
      currency: "USD",
    },
    vendor: {
      id: "ven_1",
      name: "Acme Creators LLC",
      website: "https://example.com",
      contactName: "Jordan Doe",
      paymentTerms: "Net 30",
    },
    summary: {
      totalBookedAmount: 12000,
      totalReceivedAmount: 8000,
      outstandingAmount: 4000,
      campaignCount: 3,
      paidCount: 2,
      unpaidCount: 1,
    },
    monthly: [
      { month: "2026-01", bookedAmount: 4000, receivedAmount: 4000, campaignCount: 1 },
      { month: "2026-02", bookedAmount: 8000, receivedAmount: 4000, campaignCount: 2 },
    ],
    campaigns: [
      {
        campaignId: "c1",
        name: "Spring Launch",
        bookedDate: "2026-01-10",
        amount: 4000,
        currency: "USD",
        status: "paid",
        paidAt: "2026-02-01",
      },
      {
        campaignId: "c2",
        name: "Summer Promo",
        bookedDate: "2026-02-15",
        amount: 8000,
        currency: "USD",
        status: "booked",
        paidAt: null,
      },
    ],
    skipped: [],
    ...overrides,
  };
}

describe("renderVendorReportHtml", () => {
  it("renders the vendor name and a complete HTML document", () => {
    const html = renderVendorReportHtml(sampleSnapshot());
    expect(typeof html).toBe("string");
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("Acme Creators LLC");
    expect(html).toContain("</html>");
  });

  it("includes the noindex/no-referrer robots metadata", () => {
    const html = renderVendorReportHtml(sampleSnapshot());
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).toContain('name="robots"');
    expect(html).toContain('content="no-referrer"');
  });

  it("replaces the __REPORT_DATA__ token with the embedded JSON", () => {
    const html = renderVendorReportHtml(sampleSnapshot());
    expect(html).not.toContain("__REPORT_DATA__");
    expect(html).toContain('id="report-data"');
  });

  it("escapes a script-breakout attempt in campaign data so </script> never appears raw", () => {
    const payload = "</script><script>alert(1)</script>";
    const snapshot = sampleSnapshot();
    snapshot.campaigns[0].name = payload;
    const html = renderVendorReportHtml(snapshot);

    // The raw closing-script sequence from the data must not survive: the "<"
    // must have been escaped to its < unicode form.
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script\\u003e");

    // There should be exactly the two real script tags from the template, not
    // an injected third one from the payload.
    const openTags = html.match(/<script\b/gi) || [];
    expect(openTags.length).toBe(2);
  });

  it("escapes U+2028 and U+2029 separators in the embedded JSON", () => {
    const snapshot = sampleSnapshot();
    snapshot.vendor.contactName = "Line Para End";
    const html = renderVendorReportHtml(snapshot);
    expect(html).not.toContain(" ");
    expect(html).not.toContain(" ");
    expect(html).toContain("\\u2028");
    expect(html).toContain("\\u2029");
  });

  it("is fully self-contained with no external CDN resources", () => {
    const html = renderVendorReportHtml(sampleSnapshot());
    // No src= or href= attributes pointing at an external http(s) resource.
    const externalRef = /(?:src|href)\s*=\s*["']https?:\/\//gi;
    expect(html).not.toMatch(externalRef);
    // No <link rel=stylesheet> or external <script src>.
    expect(html).not.toMatch(/<link\b[^>]*\bhref=/i);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
  });

  it("does not interpret '$' replacement patterns from the data", () => {
    const snapshot = sampleSnapshot();
    snapshot.vendor.name = "Cost $1 & $$ & $`drop";
    const html = renderVendorReportHtml(snapshot);
    expect(html).toContain("Cost $1 \\u0026 $$ \\u0026 $`drop");
  });
});
