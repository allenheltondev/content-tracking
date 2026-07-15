import { jest } from "@jest/globals";

// The emitter reads BADGE_ACTIVITY_ENABLED at module load, so set it before the
// first import. The disabled-path test re-imports with it cleared.
process.env.BADGE_ACTIVITY_ENABLED = "true";

const { EventBridgeClient } = await import("@aws-sdk/client-eventbridge");
const { trackActivity, ACTIVITY_SERVICE } = await import("../services/activity.mjs");

describe("services/activity trackActivity", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn().mockResolvedValue({});
    EventBridgeClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  test("emits a Track Activity event on the default bus with the booked service", async () => {
    await trackActivity("user-1", "campaign.created", {
      id: "campaign.created#user-1#01H",
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    const entry = command.input.Entries[0];
    expect(entry.Source).toBe(ACTIVITY_SERVICE);
    expect(entry.DetailType).toBe("Track Activity");
    expect(entry.EventBusName).toBe("default");

    const detail = JSON.parse(entry.Detail);
    expect(detail).toEqual({
      userId: "user-1",
      action: "campaign.created",
      service: "booked",
      id: "campaign.created#user-1#01H",
    });
  });

  test("passes count and value through, and omits an unset id", async () => {
    await trackActivity("user-2", "voice.composed", { count: 3, value: "linkedin" });

    const detail = JSON.parse(mockSend.mock.calls[0][0].input.Entries[0].Detail);
    expect(detail).toEqual({
      userId: "user-2",
      action: "voice.composed",
      service: "booked",
      count: 3,
      value: "linkedin",
    });
    expect("id" in detail).toBe(false);
  });

  test("skips (without calling EventBridge) when userId or action is missing", async () => {
    await trackActivity("", "campaign.created");
    await trackActivity("user-3", "");
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("swallows EventBridge failures — never throws into the request path", async () => {
    mockSend.mockRejectedValueOnce(new Error("throttled"));
    await expect(trackActivity("user-4", "radar.feed.added")).resolves.toBeUndefined();
  });

  test("is a no-op when BADGE_ACTIVITY_ENABLED is not 'true'", async () => {
    jest.resetModules();
    const prev = process.env.BADGE_ACTIVITY_ENABLED;
    delete process.env.BADGE_ACTIVITY_ENABLED;
    try {
      const { EventBridgeClient: FreshClient } = await import("@aws-sdk/client-eventbridge");
      const freshSend = jest.fn().mockResolvedValue({});
      FreshClient.prototype.send = freshSend;
      const { trackActivity: freshTrack } = await import("../services/activity.mjs");

      await freshTrack("user-5", "campaign.created", { id: "x" });
      expect(freshSend).not.toHaveBeenCalled();
    } finally {
      process.env.BADGE_ACTIVITY_ENABLED = prev;
    }
  });
});
