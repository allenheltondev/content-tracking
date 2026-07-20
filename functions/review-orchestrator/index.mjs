import { logger } from "../../api/services/logger.mjs";
import { runReview } from "../../api/services/review-runner.mjs";

// The async (fire-and-forget) entry point to the content review engine.
// Triggered by the "Start Content Review" event POST /content/{id}/reviews
// emits, it runs the shared review runner with no progress callback (the live
// streaming path passes one). The runner claims the review for idempotency, so
// a duplicate delivery no-ops; a fatal error marks the review failed and
// rethrows here so the async invocation lands in the DLQ. Retries are disabled
// on the function (EventInvokeConfig MaximumRetryAttempts: 0) so a failed run
// can't double-write suggestions — the user re-triggers instead.
export const handler = async (event) => {
  const detail = event?.detail ?? {};
  const { tenantId, contentId, reviewId, contentVersion, platform } = detail;
  if (!tenantId || !contentId || !reviewId) {
    logger.error("Start Content Review event missing identifiers", { detail });
    return;
  }

  logger.appendKeys({ tenantId, contentId, reviewId });
  await runReview({ tenantId, contentId, reviewId, contentVersion, platform });
};
