import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

const send = jest.fn();
jest.unstable_mockModule("../services/ddb.mjs", () => ({
  TABLE_NAME: "test-booked",
  ddb: { send },
}));

const {
  ensureCampaignReportLinkToken,
  resolveCampaignReportLinkToken,
  publicReportLinkUrl,
  REPORT_LINK_TOKEN_RE,
} = await import("../domain/campaign-report-link.mjs");

describe("domain/campaign-report-link", () => {
  beforeEach(() => send.mockReset());

  describe("ensureCampaignReportLinkToken", () => {
    test("returns the existing token without writing", async () => {
      send.mockResolvedValueOnce({ Item: { token: "EXISTING" } });
      await expect(ensureCampaignReportLinkToken("C1")).resolves.toBe("EXISTING");
      expect(send).toHaveBeenCalledTimes(1);
    });

    test("creates a 128-bit token with its reverse lookup on first use", async () => {
      send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
      const token = await ensureCampaignReportLinkToken("C1");

      expect(token).toMatch(REPORT_LINK_TOKEN_RE);
      const items = send.mock.calls[1][0].input.TransactItems.map((t) => t.Put.Item);
      expect(items[0]).toMatchObject({ pk: "CAMPAIGN#C1", sk: "REPORTLINK", token });
      expect(items[1]).toMatchObject({ pk: `REPORTLINK#${token}`, sk: "REPORTLINK", campaignId: "C1" });
    });

    test("adopts the winner's token when a concurrent create wins the race", async () => {
      const cancelled = Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
      send
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(cancelled)
        .mockResolvedValueOnce({ Item: { token: "WINNER" } });
      await expect(ensureCampaignReportLinkToken("C1")).resolves.toBe("WINNER");
    });
  });

  describe("resolveCampaignReportLinkToken", () => {
    test("rejects malformed tokens without a lookup", async () => {
      await expect(resolveCampaignReportLinkToken("short")).resolves.toBeNull();
      await expect(resolveCampaignReportLinkToken("../../etc/passwd/aaaaaaa")).resolves.toBeNull();
      expect(send).not.toHaveBeenCalled();
    });

    test("maps a known token to its campaign", async () => {
      send.mockResolvedValueOnce({ Item: { campaignId: "C1" } });
      await expect(resolveCampaignReportLinkToken("A".repeat(22))).resolves.toBe("C1");
    });
  });

  describe("publicReportLinkUrl", () => {
    test("keeps the stage prefix on the execute-api hostname", () => {
      const event = {
        path: "/campaigns/C1/report",
        requestContext: { domainName: "abc.execute-api.us-east-1.amazonaws.com", path: "/v1/campaigns/C1/report" },
      };
      expect(publicReportLinkUrl(event, "TOK")).toBe(
        "https://abc.execute-api.us-east-1.amazonaws.com/v1/public/campaign-reports/TOK",
      );
    });

    test("has no prefix on the custom domain", () => {
      const event = {
        path: "/campaigns/C1/report",
        requestContext: { domainName: "api.booked.example.com", path: "/campaigns/C1/report" },
      };
      expect(publicReportLinkUrl(event, "TOK")).toBe(
        "https://api.booked.example.com/public/campaign-reports/TOK",
      );
    });

    test("null without a host or token", () => {
      expect(publicReportLinkUrl({}, "TOK")).toBeNull();
      expect(publicReportLinkUrl({ requestContext: { domainName: "h" } }, null)).toBeNull();
    });
  });
});
