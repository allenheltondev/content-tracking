import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-key";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { saveDraftForCampaign, getDraftForCampaign, saveDraftReview } = await import("../domain/draft.mjs");

const CAMPAIGN_ID = "01HV0AABBCCDDEEFFGGHHJJKKM";
const DOC_URL = "https://docs.google.com/document/d/abc/edit";

describe("domain/draft", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("saveDraftForCampaign", () => {
    test("writes the draft under the campaign partition", async () => {
      mockSend.mockResolvedValueOnce({ Item: { pk: `CAMPAIGN#${CAMPAIGN_ID}`, sk: "METADATA" } }); // findCampaign
      mockSend.mockResolvedValueOnce({}); // Put

      const item = await saveDraftForCampaign({ campaignId: CAMPAIGN_ID, url: DOC_URL, docId: "abc" });

      expect(item.sk).toBe("DRAFT");
      expect(item.entity).toBe("Draft");
      expect(item.docId).toBe("abc");
      expect(item.review).toBeNull();

      const putInput = mockSend.mock.calls[1][0].input;
      expect(putInput.Item.sk).toBe("DRAFT");
      // No attribute_not_exists guard — re-saving replaces the prior draft.
      expect(putInput.ConditionExpression).toBeUndefined();
    });

    test("404 when the campaign does not exist", async () => {
      mockSend.mockResolvedValueOnce({}); // findCampaign: no Item
      await expect(
        saveDraftForCampaign({ campaignId: CAMPAIGN_ID, url: DOC_URL, docId: null }),
      ).rejects.toThrow(/Campaign .* not found/);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe("getDraftForCampaign", () => {
    test("returns the draft item", async () => {
      mockSend.mockResolvedValueOnce({ Item: { sk: "DRAFT", url: DOC_URL } });
      const draft = await getDraftForCampaign(CAMPAIGN_ID);
      expect(draft.url).toBe(DOC_URL);
      const input = mockSend.mock.calls[0][0].input;
      expect(input.Key).toEqual({ pk: `CAMPAIGN#${CAMPAIGN_ID}`, sk: "DRAFT" });
    });

    test("returns null when no draft attached", async () => {
      mockSend.mockResolvedValueOnce({});
      expect(await getDraftForCampaign(CAMPAIGN_ID)).toBeNull();
    });
  });

  describe("saveDraftReview", () => {
    test("updates the draft with the review, conditional on it existing", async () => {
      mockSend.mockResolvedValueOnce({ Attributes: { sk: "DRAFT", review: { verdict: "ready" } } });
      const out = await saveDraftReview(CAMPAIGN_ID, { verdict: "ready" });
      expect(out.review.verdict).toBe("ready");
      const input = mockSend.mock.calls[0][0].input;
      expect(input.ConditionExpression).toBe("attribute_exists(sk)");
      expect(input.Key).toEqual({ pk: `CAMPAIGN#${CAMPAIGN_ID}`, sk: "DRAFT" });
    });

    test("404 when the draft does not exist", async () => {
      const err = new Error("conditional check failed");
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValueOnce(err);
      await expect(saveDraftReview(CAMPAIGN_ID, { verdict: "ready" })).rejects.toThrow(/Draft .* not found/);
    });
  });
});
