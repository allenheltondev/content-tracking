// Sweep tracking for the background worker. A "sweep" is a batch of posts for
// one campaign that the worker scrapes through the shared tab-group queue, and
// that must end with a single sweep-complete call. This module holds the pure
// logic (post selection, due checks, completion bookkeeping) with no chrome
// dependency so it unit-tests directly. background.js owns the I/O.

// The daily auto sweep runs at most this often. Slightly under 24 hours so a
// 15-minute alarm tick never pushes the next run a full extra day out.
export const DAILY_SWEEP_INTERVAL_MS = 20 * 60 * 60 * 1000;

// Per-tab lifetime cap used to size a sweep's deadline. Mirrors
// AUTO_SCRAPE_MAX_LIFETIME_MS in background.js.
const SLOT_MS = 90_000;

function toMs(value) {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Tolerates a missing or malformed `refresh_requests` (an old API omits it).
// Keeps one entry per campaign, the latest requested_at winning.
export function normalizeRefreshRequests(raw) {
  if (!Array.isArray(raw)) return [];
  const byCampaign = new Map();
  for (const r of raw) {
    if (!r || typeof r.campaign_id !== "string" || !r.campaign_id) continue;
    const prev = byCampaign.get(r.campaign_id);
    if (!prev || (toMs(r.requested_at) ?? 0) > (toMs(prev.requested_at) ?? 0)) {
      byCampaign.set(r.campaign_id, { campaign_id: r.campaign_id, requested_at: r.requested_at });
    }
  }
  return [...byCampaign.values()];
}

// Posts of the requested campaign that still need a scrape: not already synced
// after the request was made, and not busy (live scrape tab or already queued).
export function selectRequestedPosts(feed, request, { busyPostIds = new Set() } = {}) {
  const requestedMs = toMs(request?.requested_at);
  const seen = new Set();
  const out = [];
  for (const p of feed || []) {
    if (p.campaign_id !== request?.campaign_id) continue;
    if (seen.has(p.post_id)) continue;
    seen.add(p.post_id);
    if (busyPostIds.has(p.post_id)) continue;
    const fetchedMs = toMs(p.last_fetched);
    if (fetchedMs !== null && requestedMs !== null && fetchedMs > requestedMs) continue;
    out.push(p);
  }
  return out;
}

export function isFetchedToday(post, now = Date.now()) {
  if (!post.last_fetched) return false;
  return String(post.last_fetched).slice(0, 10) === new Date(now).toISOString().slice(0, 10);
}

// Daily sweep selection across all campaigns. Returns Map(campaignId -> posts).
export function selectDailyPosts(
  feed,
  now = Date.now(),
  { busyPostIds = new Set(), skipCampaignIds = new Set() } = {},
) {
  const byCampaign = new Map();
  const seen = new Set();
  for (const p of feed || []) {
    if (!p.campaign_id || seen.has(p.post_id)) continue;
    seen.add(p.post_id);
    if (skipCampaignIds.has(p.campaign_id)) continue;
    if (busyPostIds.has(p.post_id)) continue;
    if (isFetchedToday(p, now)) continue;
    if (!byCampaign.has(p.campaign_id)) byCampaign.set(p.campaign_id, []);
    byCampaign.get(p.campaign_id).push(p);
  }
  return byCampaign;
}

export function isDailySweepDue({ enabled = true, lastRunAt, now = Date.now() } = {}) {
  if (!enabled) return false;
  const last = toMs(lastRunAt);
  if (last === null) return true;
  return now - last >= DAILY_SWEEP_INTERVAL_MS;
}

// Upper bound on how long a sweep of `count` posts can legitimately take: each
// wave of `maxConcurrent` tabs lives at most one tab lifetime, plus a spare wave.
export function sweepDeadline(startedAt, count, maxConcurrent = 5) {
  return startedAt + (Math.ceil(count / Math.max(1, maxConcurrent)) + 1) * SLOT_MS;
}

// In-memory sweep bookkeeping with a JSON snapshot so the worker can persist it.
// A campaign has at most one sweep. `begin` reserves the campaign synchronously
// (so two concurrent ticks cannot both start one); `seal` fixes the pending set.
// Only sealed sweeps can drain, and `finish` removes a sweep so the caller
// reports completion exactly once.
export function createSweepTracker({ maxConcurrent = 5 } = {}) {
  const sweeps = new Map(); // campaignId -> { source, startedAt, deadline, pending:Set, sealed }

  return {
    has: (campaignId) => sweeps.has(campaignId),
    campaignIds: () => [...sweeps.keys()],

    begin(campaignId, source, now = Date.now()) {
      if (sweeps.has(campaignId)) return false;
      sweeps.set(campaignId, {
        source,
        startedAt: now,
        deadline: now,
        pending: new Set(),
        sealed: false,
      });
      return true;
    },

    seal(campaignId, postIds, now = Date.now()) {
      const s = sweeps.get(campaignId);
      if (!s) return;
      s.pending = new Set(postIds);
      s.deadline = sweepDeadline(now, s.pending.size, maxConcurrent);
      s.sealed = true;
    },

    // A post left the scrape pipeline (synced, timed out, tab failed). Returns
    // the campaigns whose sweeps are now fully drained. They stay tracked until
    // `finish` so a failed completion call can be reasoned about by the caller.
    markDone(postId) {
      const drained = [];
      for (const [campaignId, s] of sweeps) {
        if (s.sealed && s.pending.delete(postId) && s.pending.size === 0) {
          drained.push(campaignId);
        }
      }
      return drained;
    },

    // Remove the sweep. True only for the caller that actually removed it.
    finish: (campaignId) => sweeps.delete(campaignId),

    source: (campaignId) => sweeps.get(campaignId)?.source ?? null,
    pendingPostIds: (campaignId) => [...(sweeps.get(campaignId)?.pending ?? [])],

    // Sealed sweeps past their deadline: something got lost, complete them anyway.
    overdue: (now = Date.now()) =>
      [...sweeps].filter(([, s]) => s.sealed && now >= s.deadline).map(([id]) => id),

    snapshot() {
      const out = {};
      for (const [id, s] of sweeps) {
        if (!s.sealed) continue;
        out[id] = { source: s.source, startedAt: s.startedAt, pending: [...s.pending] };
      }
      return out;
    },

    // Load a persisted snapshot after a worker restart. Campaigns already
    // tracked in memory win. Deadlines are re-armed from `now` because the
    // caller is about to requeue the pending posts. Returns restored ids.
    restore(saved, now = Date.now()) {
      const restored = [];
      if (!saved || typeof saved !== "object") return restored;
      for (const [id, s] of Object.entries(saved)) {
        if (sweeps.has(id) || !s || !Array.isArray(s.pending)) continue;
        sweeps.set(id, {
          source: s.source || "restored",
          startedAt: toMs(s.startedAt) ?? now,
          deadline: sweepDeadline(now, s.pending.length, maxConcurrent),
          pending: new Set(s.pending),
          sealed: true,
        });
        restored.push(id);
      }
      return restored;
    },
  };
}
