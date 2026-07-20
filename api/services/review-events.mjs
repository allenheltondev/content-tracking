import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { logger } from "./logger.mjs";

// Kicks off an async content review by emitting a "Start Content Review" event
// on the default EventBridge bus. The API route returns 202 immediately after
// this; the ReviewOrchestratorFunction consumes the event and runs the lenses.
// Same pattern the app uses for badge activity and agent-session creation, so
// the API Lambda needs only events:PutEvents (already granted).

export const REVIEW_EVENT_SOURCE = "booked";
export const START_REVIEW_DETAIL_TYPE = "Start Content Review";

const BUS_NAME = process.env.REVIEW_EVENT_BUS_NAME || "default";

let client;
function getClient() {
  if (!client) client = new EventBridgeClient();
  return client;
}

// Emits the kickoff event. Throws on failure so the route can surface a 502 —
// unlike best-effort badge activity, a review that never starts should not
// report success to the caller.
export async function emitStartReview({ tenantId, contentId, reviewId, contentVersion, platform }) {
  const result = await getClient().send(new PutEventsCommand({
    Entries: [
      {
        EventBusName: BUS_NAME,
        Source: REVIEW_EVENT_SOURCE,
        DetailType: START_REVIEW_DETAIL_TYPE,
        Detail: JSON.stringify({ tenantId, contentId, reviewId, contentVersion, platform }),
      },
    ],
  }));

  if (result.FailedEntryCount && result.FailedEntryCount > 0) {
    logger.error("Failed to emit Start Content Review event", {
      contentId,
      reviewId,
      failed: result.Entries?.[0]?.ErrorMessage,
    });
    throw new Error("Failed to start review");
  }
}
