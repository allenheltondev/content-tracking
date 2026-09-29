import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

const send = jest.fn();
jest.unstable_mockModule("../../api/services/s3.mjs", () => ({ s3: { send } }));

process.env.VENDOR_REPORTS_BUCKET = "reports-bucket";
const { handler } = await import("./index.mjs");

function ttlRemove(item, principalId = "dynamodb.amazonaws.com") {
  return {
    eventName: "REMOVE",
    userIdentity: { type: "Service", principalId },
    dynamodb: { OldImage: marshall(item) },
  };
}

const REPORT = {
  entity: "CampaignReport",
  campaignId: "C1",
  reportId: "R1",
  key: "reports/campaigns/C1/R1.html",
};

describe("campaign-report-cleanup", () => {
  beforeEach(() => send.mockReset().mockResolvedValue({}));

  test("deletes the report object when TTL removes its record", async () => {
    await handler({ Records: [ttlRemove(REPORT)] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: "reports-bucket",
      Key: "reports/campaigns/C1/R1.html",
    });
  });

  test("ignores removals that were not TTL expiries", async () => {
    await handler({ Records: [ttlRemove(REPORT, "someone-else")] });
    expect(send).not.toHaveBeenCalled();
  });

  test("ignores other entities and keys outside the campaign prefix", async () => {
    await handler({
      Records: [
        ttlRemove({ ...REPORT, entity: "VendorReport" }),
        ttlRemove({ ...REPORT, key: "reports/vendors/V1/R1.html" }),
        { eventName: "MODIFY", dynamodb: { NewImage: marshall(REPORT) } },
      ],
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("propagates S3 failures so the stream retries", async () => {
    send.mockRejectedValue(new Error("throttled"));
    await expect(handler({ Records: [ttlRemove(REPORT)] })).rejects.toThrow("throttled");
  });
});
