import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { logger } from "./logger.mjs";

// Emits gamification "activity" to the shared Badge Chest engine that lives in
// readysetcloud/rsc-core. An activity is a fact — "user X did Y" — and that is
// all this app is responsible for: the central rules engine decides whether an
// activity earns a badge, what it's worth, and how it rolls up into points and
// levels. We never own any of that here.
//
// Transport is a "Track Activity" event on the default EventBridge bus, which
// rsc-core's ProcessActivityFunction matches on (detail-type "Track Activity").
// Both stacks share one AWS account and one Cognito user pool, so the Cognito
// `sub` we already resolve on every request (see services/identity.mjs) IS the
// cross-app identity the chest is keyed on — no extra id mapping needed.
//
// Design constraints:
//   * Best-effort. A badge write must never fail, slow, or change the outcome
//     of the user's real request, so every error here is swallowed with a warn.
//   * Cheap to emit for unregistered metrics. The engine ignores an `action`
//     no badge references, so it's safe to emit a metric before its catalog
//     entry exists (the catalog lives in rsc-core and lands in a follow-on PR).
//   * Off by default. Gated on BADGE_ACTIVITY_ENABLED so tests and any context
//     that hasn't opted in never touch EventBridge.
//
// The activity contract (action names, service scoping, idempotency ids) is
// documented in rsc-core's functions/badges/AGENTS.md.

// Every activity this app emits is scoped to the "booked" service. rsc-core's
// booked badges use `criteria.service: "booked"`, which is only satisfied by
// the per-service counter — and that counter only moves when the emitted
// activity carries a matching `service`. So this must always be sent.
export const ACTIVITY_SERVICE = "booked";

const DETAIL_TYPE = "Track Activity";
const BUS_NAME = process.env.ACTIVITY_EVENT_BUS_NAME || "default";
const ENABLED = process.env.BADGE_ACTIVITY_ENABLED === "true";

// One client per execution environment, created lazily so importing this module
// (which app.mjs does transitively for every route) costs nothing when badge
// emission is disabled.
let client;
function getClient() {
  if (!client) {
    client = new EventBridgeClient();
  }
  return client;
}

/**
 * Emit a single gamification activity for a user.
 *
 * @param {string} userId  The caller's Cognito `sub` (from requireTenantId /
 *                         resolveTenantId). Required.
 * @param {string} action  Stable, dot-namespaced metric name, e.g.
 *                         "campaign.created". Required. Keep it stable — it's
 *                         the contract with the badge catalog.
 * @param {object} [opts]
 * @param {number} [opts.count]  Increment size (engine default 1). For batches.
 * @param {string} [opts.value]  Distinct dimension for `unique` badges.
 * @param {string} [opts.id]     Idempotency key. When set, the engine counts
 *                               this activity exactly once. Make it
 *                               deterministic from the thing that happened
 *                               (e.g. `campaign.created#<userId>#<campaignId>`)
 *                               so a retry produces the same id.
 * @returns {Promise<void>} Always resolves; never throws.
 */
export async function trackActivity(userId, action, { count, value, id } = {}) {
  if (!ENABLED) return;
  if (!userId || !action) {
    logger.warn("Skipping activity with missing userId/action", { action: action ?? null });
    return;
  }

  const detail = { userId, action, service: ACTIVITY_SERVICE };
  if (id) detail.id = id;
  if (count !== undefined) detail.count = count;
  if (value !== undefined) detail.value = value;

  try {
    await getClient().send(
      new PutEventsCommand({
        Entries: [
          {
            Source: ACTIVITY_SERVICE,
            DetailType: DETAIL_TYPE,
            EventBusName: BUS_NAME,
            Detail: JSON.stringify(detail),
          },
        ],
      }),
    );
  } catch (err) {
    // Swallow: gamification is a side effect, not part of the request contract.
    logger.warn("Failed to emit Track Activity event", { action, error: err?.message });
  }
}
