import { requireTenantId } from "../services/identity.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError } from "../services/errors.mjs";
import { getContent } from "../domain/content.mjs";
import { emitStartReview } from "../services/review-events.mjs";
import {
  createReview,
  completeReview,
  getReview,
  getLatestReview,
  listSuggestions,
  updateSuggestionStatus,
} from "../domain/content-review.mjs";
import {
  formatReview,
  formatSuggestion,
  validateStartReview,
  validateSuggestionStatusUpdate,
} from "../validation/content-review.mjs";

// The content review feature: a "digital copyedit team" that reviews a piece of
// content and returns specific, offset-anchored suggestions the author accepts,
// rejects, or edits inline. Every route resolves the tenant from the authorizer
// sub (requireTenantId) so reads/writes stay inside the caller's TENANT#{sub}
// partition, and every route confirms the content exists first (404 otherwise),
// which also enforces that the content belongs to the caller.
//
// Reviews and suggestions are child rows of the Content entity (see
// domain/content-review.mjs). The review ENGINE — the multi-lens agents that
// generate suggestions — is wired in a later phase on the rsc-core
// @readysetcloud/agent runtime; this module owns opening a review, reading its
// status, and the accept/reject/dismiss loop over the suggestions it produces.

export function registerContentReviewRoutes(app) {
  // POST /content/{contentId}/reviews — kick off a review of the current draft.
  // Records a pending review stamped with the body snapshot it will analyse and
  // returns it immediately (202); the engine fills in suggestions + summary
  // asynchronously, and the client watches via GET .../reviews/{reviewId} (or
  // the live stream). Idempotency isn't applied — each press is a fresh review
  // of whatever the draft says now.
  app.post("/content/:contentId/reviews", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const { platform } = validateStartReview(parseBody(event, { optional: true }));

    const content = await getContent(tenantId, params.contentId);
    if (!content.contentMarkdown || content.contentMarkdown.trim().length === 0) {
      throw new BadRequestError("content has no body to review");
    }

    const review = await createReview(tenantId, params.contentId, {
      contentVersion: content.updatedAt,
    });

    // Dispatch the multi-lens review asynchronously: the
    // ReviewOrchestratorFunction consumes this event, runs the lenses on the
    // rsc-core @readysetcloud/agent runtime, records anchored suggestions, and
    // closes the run with completeReview. The client watches via
    // GET .../reviews/{reviewId} (or the live stream).
    //
    // If the event can't be published, the just-created review would otherwise
    // be orphaned as `pending` forever (and surface as the latest review on
    // GET .../suggestions until TTL). Mark it failed before surfacing the error
    // so no orphan lingers.
    try {
      await emitStartReview({
        tenantId,
        contentId: params.contentId,
        reviewId: review.reviewId,
        contentVersion: content.updatedAt,
        platform,
      });
    } catch (err) {
      await completeReview(tenantId, params.contentId, review.reviewId, {
        status: "failed",
        summary: "The review could not be started.",
      }).catch(() => {});
      throw err;
    }

    return jsonResponse(202, formatReview(review));
  });

  // GET /content/{contentId}/reviews/{reviewId} — poll a review's status and, on
  // completion, its editorial summary. The primary "review finished" signal is
  // the live stream; this is the reload/fallback read.
  app.get("/content/:contentId/reviews/:reviewId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    await getContent(tenantId, params.contentId);
    const review = await getReview(tenantId, params.contentId, params.reviewId);
    return jsonResponse(200, formatReview(review));
  });

  // GET /content/{contentId}/suggestions — the pending suggestions for a piece
  // of content plus the latest review's summary, everything the editor needs to
  // render highlights and the summary panel in one call.
  app.get("/content/:contentId/suggestions", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    await getContent(tenantId, params.contentId);

    const [suggestions, latestReview] = await Promise.all([
      listSuggestions(tenantId, params.contentId, { status: "pending" }),
      getLatestReview(tenantId, params.contentId),
    ]);

    return jsonResponse(200, {
      suggestions: suggestions.map(formatSuggestion),
      review: formatReview(latestReview),
    });
  });

  // POST /content/{contentId}/suggestions/{suggestionId}/status — resolve a
  // suggestion (accepted / rejected / dismissed). Applying the accepted edit to
  // the body is the client's job (it owns the live text + offset recalculation);
  // this records the decision. A no-op transition to the same status returns 204.
  app.post("/content/:contentId/suggestions/:suggestionId/status", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const { status } = validateSuggestionStatusUpdate(parseBody(event));

    await getContent(tenantId, params.contentId);
    const updated = await updateSuggestionStatus(
      tenantId,
      params.contentId,
      params.suggestionId,
      status,
    );
    return jsonResponse(200, formatSuggestion(updated));
  });
}

// Mirrors the per-route body parser used across this service (see routes/
// voice.mjs). `optional` allows an absent body (POST /reviews takes none).
function parseBody(event, { optional = false } = {}) {
  if (!event.body) {
    if (optional) return undefined;
    throw new BadRequestError("Missing request body");
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}
