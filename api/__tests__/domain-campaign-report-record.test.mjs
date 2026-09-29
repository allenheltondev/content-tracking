import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

const send = jest.fn();
jest.unstable_mockModule("../services/ddb.mjs", () => ({
  TABLE_NAME: "test-booked",
  ddb: { send },
}));

const {
  listCampaignReportRecords,
  findNewestCampaignReportRecord,
  claimCampaignReportSupersede,
  releaseCampaignReportSupersede,
} = await import("../domain/campaign-report-record.mjs");

describe("domain/campaign-report-record", () => {
  beforeEach(() => send.mockReset());

  test("lists every page newest-first", async () => {
    send
      .mockResolvedValueOnce({ Items: [{ reportId: "R3" }, { reportId: "R2" }], LastEvaluatedKey: { sk: "x" } })
      .mockResolvedValueOnce({ Items: [{ reportId: "R1" }] });

    const records = await listCampaignReportRecords("C1");

    expect(records.map((r) => r.reportId)).toEqual(["R3", "R2", "R1"]);
    expect(send.mock.calls[0][0].input).toMatchObject({ ScanIndexForward: false });
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ sk: "x" });
  });

  test("finds the newest match and stops paging", async () => {
    send
      .mockResolvedValueOnce({ Items: [{ reportId: "R3", live: false }], LastEvaluatedKey: { sk: "a" } })
      .mockResolvedValueOnce({ Items: [{ reportId: "R2", live: true }], LastEvaluatedKey: { sk: "b" } });

    const found = await findNewestCampaignReportRecord("C1", (r) => r.live);

    expect(found.reportId).toBe("R2");
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("returns null when nothing matches", async () => {
    send.mockResolvedValueOnce({ Items: [{ reportId: "R1", live: false }] });
    await expect(findNewestCampaignReportRecord("C1", (r) => r.live)).resolves.toBeNull();
  });

  describe("supersede claims", () => {
    const conditionFailed = () =>
      Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });

    test("claims only when unclaimed or held by an older generation", async () => {
      send.mockResolvedValueOnce({});
      await expect(
        claimCampaignReportSupersede("C1", "R1", { byReportId: "R5", supersededAt: "t" }),
      ).resolves.toBe(true);

      const input = send.mock.calls[0][0].input;
      expect(input.ConditionExpression).toBe(
        "attribute_exists(pk) AND (attribute_not_exists(supersededByReportId) OR supersededByReportId < :by)",
      );
      expect(input.ExpressionAttributeValues).toEqual({ ":by": "R5", ":at": "t" });
    });

    test("reports false when a newer generation holds the claim", async () => {
      send.mockRejectedValueOnce(conditionFailed());
      await expect(
        claimCampaignReportSupersede("C1", "R1", { byReportId: "R2", supersededAt: "t" }),
      ).resolves.toBe(false);
    });

    test("release only removes this generation's own claim", async () => {
      send.mockRejectedValueOnce(conditionFailed());
      await expect(releaseCampaignReportSupersede("C1", "R1", "R2")).resolves.toBeUndefined();
      expect(send.mock.calls[0][0].input.ConditionExpression).toBe("supersededByReportId = :by");
    });
  });
});
