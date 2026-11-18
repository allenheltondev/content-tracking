import {
  DAILY_SWEEP_INTERVAL_MS,
  createSweepTracker,
  isDailySweepDue,
  normalizeRefreshRequests,
  selectDailyPosts,
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

  test("skips busy posts and duplicates", () => {
    const feed = [post("a", "c1", null), post("a", "c1", null), post("b", "c1", null)];
    const out = selectRequestedPosts(feed, request, { busyPostIds: new Set(["b"]) });
    expect(out.map((p) => p.post_id)).toEqual(["a"]);
  });

  test("returns nothing when every post is fresh", () => {
    const feed = [post("a", "c1", "2026-11-18T10:00:01Z")];
    expect(selectRequestedPosts(feed, request)).toEqual([]);
  });
});

describe("daily sweep", () => {
  test("due check honors the flag and the ~20h interval", () => {
    expect(isDailySweepDue({ enabled: false, lastRunAt: undefined, now: NOW })).toBe(false);
    expect(isDailySweepDue({ enabled: true, lastRunAt: undefined, now: NOW })).toBe(true);
    expect(isDailySweepDue({ lastRunAt: NOW - DAILY_SWEEP_INTERVAL_MS + 1, now: NOW })).toBe(false);
    expect(isDailySweepDue({ lastRunAt: NOW - DAILY_SWEEP_INTERVAL_MS, now: NOW })).toBe(true);
  });

  test("selects posts not fetched today, grouped by campaign", () => {
    const feed = [
      post("a", "c1", "2026-11-18T01:00:00Z"), // today: skip
      post("b", "c1", "2026-11-17T23:00:00Z"),
      post("c", "c2", null),
      post("d", "c3", "2026-11-10T00:00:00Z"),
    ];
    const out = selectDailyPosts(feed, NOW, {
      busyPostIds: new Set(["c"]),
      skipCampaignIds: new Set(["c3"]),
    });
    expect([...out.keys()]).toEqual(["c1"]);
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

  test("a timed-out post counts as done so the sweep still completes", () => {
    const t = createSweepTracker();
    t.begin("c1", "requested", NOW);
    t.seal("c1", ["a", "stuck"], NOW);
    t.markDone("a");
    expect(t.markDone("stuck")).toEqual(["c1"]); // the timeout path calls markDone
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
      calls.push([url, init.method]);
      return { ok: true, text: async () => JSON.stringify({ campaign_id: "c1", regenerated: true }) };
    };
    await expect(completeSweep("c1")).resolves.toEqual({ campaign_id: "c1", regenerated: true });
    expect(calls).toEqual([["https://api.test/v1/monitoring/campaigns/c1/sweep-complete", "POST"]]);
  });
});
