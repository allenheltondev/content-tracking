import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

const send = jest.fn();
jest.unstable_mockModule("../services/ddb.mjs", () => ({
  TABLE_NAME: "test-booked",
  ddb: { send },
}));

const { listCampaignReportRecords, findNewestCampaignReportRecord } = await import(
  "../domain/campaign-report-record.mjs"
);

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
});
