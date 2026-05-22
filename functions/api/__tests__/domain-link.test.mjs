import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-content-tracking";
process.env.ENVIRONMENT = "staging";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-key";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");

// Mock the newsletter-service client. The link domain depends on it for
// mint / unmint, and we don't want the tests to hit fetch or SSM.
jest.unstable_mockModule("../services/newsletter-service.mjs", () => ({
  mintShortLink: jest.fn(),
  unmintShortLink: jest.fn(),
  fetchLinkAnalytics: jest.fn(),
}));

const newsletterService = await import("../services/newsletter-service.mjs");
const {
  createLink,
  getLink,
  updateLink,
  deleteLink,
} = await import("../domain/link.mjs");

describe("domain/link", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
    newsletterService.mintShortLink.mockReset();
    newsletterService.unmintShortLink.mockReset();
    newsletterService.fetchLinkAnalytics.mockReset();
  });

  describe("createLink", () => {
    test("404 when campaign doesn't exist", async () => {
      mockSend.mockResolvedValueOnce({}); // findCampaign returns no item
      await expect(
        createLink("C1", { role: "main", platform: "x", url: "https://e.com" }),
      ).rejects.toThrow(/Campaign C1 not found/);
    });

    test("mints then writes the link item", async () => {
      mockSend.mockResolvedValueOnce({ Item: { pk: "CAMPAIGN#C1" } }); // findCampaign
      newsletterService.mintShortLink.mockResolvedValueOnce({
        code: "AbCdEf",
        short_url: "https://rdyset.click/c/AbCdEf",
        expires_at: "2026-12-31",
      });
      mockSend.mockResolvedValueOnce({}); // PutItem

      const item = await createLink("C1", {
        role: "main",
        platform: "x",
        url: "https://example.com/post",
      });

      expect(item.linkId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(item.code).toBe("AbCdEf");
      expect(item.shortUrl).toBe("https://rdyset.click/c/AbCdEf");
      expect(item.pk).toBe("CAMPAIGN#C1");
      expect(item.sk).toBe(`LINK#${item.linkId}`);
    });
  });

  describe("getLink", () => {
    test("returns item when present", async () => {
      mockSend.mockResolvedValueOnce({ Item: { linkId: "L1", code: "abc" } });
      const item = await getLink("C1", "L1");
      expect(item.code).toBe("abc");
    });

    test("404 when missing", async () => {
      mockSend.mockResolvedValueOnce({});
      await expect(getLink("C1", "L1")).rejects.toThrow(/Link L1 not found/);
    });
  });

  describe("updateLink", () => {
    test("SET + REMOVE based on null vs value", async () => {
      mockSend.mockResolvedValueOnce({ Attributes: { linkId: "L1" } });
      await updateLink("C1", "L1", { notes: "new note", src: null });
      const input = mockSend.mock.calls[0][0].input;
      expect(input.UpdateExpression).toMatch(/SET #notes = :notes/);
      expect(input.UpdateExpression).toMatch(/REMOVE #src/);
    });

    test("404 on ConditionalCheckFailed", async () => {
      const err = new Error();
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValueOnce(err);
      await expect(updateLink("C1", "L1", { notes: "x" })).rejects.toThrow(/Link L1 not found/);
    });
  });

  describe("deleteLink", () => {
    test("404 when link missing", async () => {
      mockSend.mockResolvedValueOnce({}); // findLink returns no item
      await expect(deleteLink("C1", "L1")).rejects.toThrow(/Link L1 not found/);
      expect(newsletterService.unmintShortLink).not.toHaveBeenCalled();
    });

    test("calls upstream then deletes local", async () => {
      mockSend.mockResolvedValueOnce({ Item: { code: "AbCdEf", linkId: "L1" } });
      newsletterService.unmintShortLink.mockResolvedValueOnce({ alreadyGone: false });
      mockSend.mockResolvedValueOnce({}); // DeleteItem

      await deleteLink("C1", "L1");

      expect(newsletterService.unmintShortLink).toHaveBeenCalledWith("AbCdEf");
      expect(mockSend.mock.calls[1][0].input.Key).toEqual({ pk: "CAMPAIGN#C1", sk: "LINK#L1" });
    });
  });
});
