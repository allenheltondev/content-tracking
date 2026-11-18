import { jest } from "@jest/globals";
import {
  createSweepTracker,
  openTrackedTab,
  MAX_REQUESTED_SWEEP_ATTEMPTS,
  sweepCompletion,
  isScheduledSweepDue,
  normalizeRefreshRequests,
  selectScheduledPosts,
  sweepIntervalHours,
  selectRequestedPosts,
  sweepDeadline,
} from "../src/sweeps.js";
import { getMonitoringWorkingSet, completeSweep } from "../src/api.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const post = (id, campaign, last_fetched) => ({ post_id: id, campaign_id: campaign, last_fetched });

describe("normalizeRefreshRequests", () => {
  test("tolerates a missing field", () => {
    expect(normalizeRefreshRequests(undefined)).toEqual([]);
    expect(normalizeRefreshRequests(null)).toEqual([]);
    expect(normalizeRefreshRequests("nope")).toEqual([]);
  });

  test("drops malformed entries and keeps the latest per campaign", () => {
    const out = normalizeRefreshRequests([
      { campaign_id: "c1", requested_at: "2026-11-18T10:00:00Z" },
      { campaign_id: "c1", requested_at: "2026-11-18T11:00:00Z" },
      { requested_at: "2026-11-18T11:00:00Z" },
      null,
    ]);
    expect(out).toEqual([{ campaign_id: "c1", requested_at: "2026-11-18T11:00:00Z" }]);
  });
});

describe("selectRequestedPosts", () => {
  const request = { campaign_id: "c1", requested_at: "2026-11-18T10:00:00Z" };

  test("only the campaign's posts that were not fetched after the request", () => {
    const feed = [
      post("a", "c1", "2026-11-18T09:00:00Z"), // older than request: scrape
      post("b", "c1", "2026-11-18T10:30:00Z"), // newer: skip
      post("c", "c1", null), // never fetched: scrape
      post("d", "c2", null), // other campaign
    ];
    expect(selectRequestedPosts(feed, request).map((p) => p.post_id)).toEqual(["a", "c"]);
  });

  test("drops duplicates and keeps posts that are already being scraped", () => {
    // "b" may have a live tab; the sweep must wait for it, so it is selected.
    const feed = [post("a", "c1", null), post("a", "c1", null), post("b", "c1", null)];
    expect(selectRequestedPosts(feed, request).map((p) => p.post_id)).toEqual(["a", "b"]);
  });

  test("returns nothing when every post is fresh", () => {
    const feed = [post("a", "c1", "2026-11-18T10:00:01Z")];
    expect(selectRequestedPosts(feed, request)).toEqual([]);
  });
});

describe("scheduled sweep", () => {
  const HOUR = 60 * 60 * 1000;

  test("due check honors off and the chosen interval", () => {
    expect(isScheduledSweepDue({ intervalHours: 0, lastRunAt: undefined, now: NOW })).toBe(false);
    expect(isScheduledSweepDue({ lastRunAt: undefined, now: NOW })).toBe(true);
    // Once a day waits 20 hours.
    expect(isScheduledSweepDue({ lastRunAt: NOW - 20 * HOUR + 1, now: NOW })).toBe(false);
    expect(isScheduledSweepDue({ lastRunAt: NOW - 20 * HOUR, now: NOW })).toBe(true);
    expect(isScheduledSweepDue({ intervalHours: 6, lastRunAt: NOW - 6 * HOUR + 1, now: NOW })).toBe(false);
    expect(isScheduledSweepDue({ intervalHours: 6, lastRunAt: NOW - 6 * HOUR, now: NOW })).toBe(true);
  });

  test("resolves the interval from config, including the older on/off flag", () => {
    expect(sweepIntervalHours({})).toBe(24);
    expect(sweepIntervalHours({ sweepIntervalHours: 6 })).toBe(6);
    expect(sweepIntervalHours({ sweepIntervalHours: 0 })).toBe(0);
    expect(sweepIntervalHours({ sweepIntervalHours: 5 })).toBe(24);
    expect(sweepIntervalHours({ dailySweepEnabled: false })).toBe(0);
    expect(sweepIntervalHours({ dailySweepEnabled: false, sweepIntervalHours: 12 })).toBe(12);
  });

  test("a shorter interval sweeps posts a daily sweep would skip", () => {
    const feed = [post("a", "c1", new Date(NOW - 4 * HOUR).toISOString())];
    expect(selectScheduledPosts(feed, NOW, { intervalHours: 24 }).size).toBe(0);
    expect(selectScheduledPosts(feed, NOW, { intervalHours: 6 }).get("c1")).toHaveLength(1);
  });

  test("selects posts older than half the interval, grouped by campaign", () => {
    const feed = [
      post("a", "c1", new Date(NOW - HOUR).toISOString()), // fresh: skip
      post("b", "c1", new Date(NOW - 13 * HOUR).toISOString()),
      post("c", "c2", null),
      post("d", "c3", "2026-11-10T00:00:00Z"),
    ];
    const out = selectScheduledPosts(feed, NOW, { skipCampaignIds: new Set(["c3"]) });
    expect([...out.keys()]).toEqual(["c1", "c2"]);
    expect(out.get("c1").map((p) => p.post_id)).toEqual(["b"]);
  });
});

describe("createSweepTracker", () => {
  test("drains once and reports each campaign once", () => {
    const t = createSweepTracker();
    expect(t.begin("c1", "requested", NOW)).toBe(true);
    expect(t.begin("c1", "daily", NOW)).toBe(false); // no second sweep in flight
    t.seal("c1", ["a", "b"], NOW);
    expect(t.markDone("a")).toEqual([]);
    expect(t.markDone("a")).toEqual([]); // idempotent
    expect(t.markDone("b")).toEqual(["c1"]);
    expect(t.finish("c1")).toBe(true);
    expect(t.finish("c1")).toBe(false); // second caller does not re-report
    expect(t.markDone("b")).toEqual([]);
  });

  test("a timed-out post drains the sweep and is recorded as failed", () => {
    const t = createSweepTracker();
    t.begin("c1", "requested", NOW);
    t.seal("c1", ["a", "stuck"], NOW);
    t.markDone("a", true);
    expect(t.failedPostIds("c1")).toEqual(["stuck"]); // still pending counts as not synced
    expect(t.markDone("stuck", false)).toEqual(["c1"]); // the timeout path
    expect(t.failedPostIds("c1")).toEqual(["stuck"]);
  });

  test("a clean sweep has no failed posts", () => {
    const t = createSweepTracker();
    t.begin("c1", "requested", NOW);
    t.seal("c1", ["a", "b"], NOW);
    t.markDone("a", true);
    expect(t.markDone("b", true)).toEqual(["c1"]);
    expect(t.failedPostIds("c1")).toEqual([]);
  });

  test("isPending tracks posts a sealed sweep still waits on", () => {
    const t = createSweepTracker();
    t.begin("c1", "requested", NOW);
    expect(t.isPending("a")).toBe(false); // not sealed yet
    t.seal("c1", ["a"], NOW);
    expect(t.isPending("a")).toBe(true);
    t.markDone("a", true);
    expect(t.isPending("a")).toBe(false);
  });

  test("failures survive a snapshot round trip", () => {
    const t = createSweepTracker();
    t.begin("c1", "requested", NOW);
    t.seal("c1", ["a", "b"], NOW);
    t.markDone("a", false);
    const t2 = createSweepTracker();
    t2.restore(JSON.parse(JSON.stringify(t.snapshot())), NOW);
    expect(t2.markDone("b", true)).toEqual(["c1"]);
    expect(t2.failedPostIds("c1")).toEqual(["a"]);
  });

  test("an unsealed sweep cannot drain", () => {
    const t = createSweepTracker();
    t.begin("c1", "daily", NOW);
    expect(t.markDone("a")).toEqual([]);
    expect(t.snapshot()).toEqual({});
  });

  test("overdue sweeps are reported after the deadline", () => {
    const t = createSweepTracker({ maxConcurrent: 5 });
    t.begin("c1", "requested", NOW);
    t.seal("c1", ["a"], NOW);
    const deadline = sweepDeadline(NOW, 1, 5);
    expect(t.overdue(deadline - 1)).toEqual([]);
    expect(t.overdue(deadline)).toEqual(["c1"]);
  });

  test("snapshot round-trips after a worker restart", () => {
    const t = createSweepTracker();
    t.begin("c1", "requested", NOW);
    t.seal("c1", ["a", "b"], NOW);
    t.markDone("a");
    const saved = JSON.parse(JSON.stringify(t.snapshot()));

    const t2 = createSweepTracker();
    expect(t2.restore(saved, NOW + 5000)).toEqual(["c1"]);
    expect(t2.pendingPostIds("c1")).toEqual(["b"]);
    expect(t2.begin("c1", "daily")).toBe(false);
    expect(t2.markDone("b")).toEqual(["c1"]);
  });

  test("restore does not clobber a sweep already in memory", () => {
    const t = createSweepTracker();
    t.begin("c1", "requested", NOW);
    expect(t.restore({ c1: { source: "daily", pending: ["x"] } })).toEqual([]);
    expect(t.source("c1")).toBe("requested");
  });
});

describe("openTrackedTab", () => {
  test("a capture that arrives while the tab is being grouped finds it registered", async () => {
    const active = new Map();
    let releaseGroup;
    const grouping = new Promise((resolve) => {
      releaseGroup = resolve;
    });
    const opening = openTrackedTab({
      create: async () => ({ id: 7 }),
      register: (tab) => active.set("post-1", tab.id),
      group: () => grouping,
    });
    // Let create resolve; grouping is still pending.
    await Promise.resolve();
    await Promise.resolve();
    // The early capture: the close hook looks the post up and removes it.
    expect(active.get("post-1")).toBe(7);
    active.delete("post-1");
    releaseGroup();
    await expect(opening).resolves.toEqual({ id: 7 });
    // Finishing the grouping does not register the closed tab again.
    expect(active.has("post-1")).toBe(false);
  });

  test("a grouping error still leaves the tab registered", async () => {
    const active = new Map();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await openTrackedTab({
      create: async () => ({ id: 8 }),
      register: (tab) => active.set("post-2", tab.id),
      group: async () => {
        throw new Error("no group");
      },
    });
    warn.mockRestore();
    expect(active.get("post-2")).toBe(8);
  });

  test("a failed create registers nothing and rejects", async () => {
    const register = jest.fn();
    await expect(
      openTrackedTab({ create: async () => Promise.reject(new Error("boom")), register }),
    ).rejects.toThrow("boom");
    expect(register).not.toHaveBeenCalled();
  });
});

describe("sweepCompletion", () => {
  test("a clean sweep is complete and resets the attempt count", () => {
    expect(sweepCompletion({ source: "requested", failedCount: 0, attempts: 2 })).toEqual({
      partial: false,
      attempts: 0,
    });
  });

  test("a requested sweep with failures is partial until the attempts run out", () => {
    let attempts = 0;
    for (let i = 1; i < MAX_REQUESTED_SWEEP_ATTEMPTS; i += 1) {
      const out = sweepCompletion({ source: "requested", failedCount: 1, attempts });
      expect(out).toEqual({ partial: true, attempts: i });
      attempts = out.attempts;
    }
    expect(sweepCompletion({ source: "requested", failedCount: 1, attempts })).toEqual({
      partial: false,
      attempts: 0,
    });
  });

  test("a scheduled sweep with failures is always partial", () => {
    expect(sweepCompletion({ source: "daily", failedCount: 2, attempts: 5 })).toEqual({
      partial: true,
      attempts: 0,
    });
  });
});

describe("api client", () => {
  const realFetch = global.fetch;
  const realChrome = global.chrome;
  let calls;

  beforeEach(() => {
    calls = [];
    const store = {
      booked_config: { apiBaseUrl: "https://api.test/v1" },
      booked_pairing: { token: "tok" },
    };
    global.chrome = {
      storage: {
        local: {
          get: async (k) => (typeof k === "string" ? { [k]: store[k] } : { ...store }),
        },
      },
    };
  });
  afterEach(() => {
    global.fetch = realFetch;
    global.chrome = realChrome;
  });

  test("working set without refresh_requests yields an empty array", async () => {
    global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ social_posts: [] }) });
    const ws = await getMonitoringWorkingSet();
    expect(ws.refreshRequests).toEqual([]);
  });

  test("working set passes refresh_requests through", async () => {
    const req = [{ campaign_id: "c1", requested_at: "2026-11-18T10:00:00Z" }];
    global.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({ refresh_requests: req }),
    });
    expect((await getMonitoringWorkingSet()).refreshRequests).toEqual(req);
  });

  test("completeSweep POSTs to the sweep-complete path", async () => {
    global.fetch = async (url, init) => {
      calls.push([url, init.method, init.body]);
      return { ok: true, text: async () => JSON.stringify({ campaign_id: "c1", regenerated: true }) };
    };
    const url = "https://api.test/v1/monitoring/campaigns/c1/sweep-complete";
    await expect(completeSweep("c1")).resolves.toEqual({ campaign_id: "c1", regenerated: true });
    await completeSweep("c1", { partial: true });
    expect(calls).toEqual([
      [url, "POST", undefined],
      [url, "POST", JSON.stringify({ partial: true })],
    ]);
  });
});
