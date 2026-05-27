import { Router } from "@aws-lambda-powertools/event-handler/http";
import { registerVendorRoutes } from "./routes/vendors.mjs";
import { registerCampaignRoutes } from "./routes/campaigns.mjs";
import { registerLinkRoutes } from "./routes/links.mjs";
import { registerSocialPostRoutes } from "./routes/social-posts.mjs";
import { registerAnalyticsRoutes } from "./routes/analytics.mjs";
import { registerPayoutRoutes } from "./routes/payout.mjs";
import { registerRevenueRoutes } from "./routes/revenue.mjs";
import { logger } from "./services/logger.mjs";
import { jsonResponse } from "./services/http-handler.mjs";
import { ApiError } from "./services/errors.mjs";

export const app = new Router();

registerVendorRoutes(app);
registerCampaignRoutes(app);
registerLinkRoutes(app);
registerSocialPostRoutes(app);
registerAnalyticsRoutes(app);
registerPayoutRoutes(app);
registerRevenueRoutes(app);

app.notFound(({ event }) => {
  const method = event.httpMethod || event?.requestContext?.http?.method;
  const path = event.path || event?.requestContext?.http?.path;
  logger.warn("Route not matched", { method, path });
  return jsonResponse(404, { message: `No route registered for ${method} ${path}` });
});

// The Powertools Router catches handler errors inside its own #resolve
// and otherwise only logs them at debug level. Without this handler,
// thrown errors silently become a default 500 with nothing in
// CloudWatch.
app.errorHandler(Error, (err, { event }) => {
  const method = event?.httpMethod || event?.requestContext?.http?.method;
  const path = event?.path || event?.requestContext?.http?.path;

  if (err instanceof ApiError) {
    logger.warn("handler mapped error", {
      method,
      path,
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
    });
    return jsonResponse(err.statusCode, { message: err.message, code: err.code });
  }

  logger.error("handler unhandled error", {
    method,
    path,
    errorName: err?.name,
    error: err?.message,
    stack: err?.stack,
    causeChain: serializeCauseChain(err),
  });
  return jsonResponse(500, { message: "Internal server error" });
});

// Walks Error.cause links so wrapping errors (Powertools idempotency,
// AWS SDK middleware, etc.) don't bury the real failure. Capped at 5
// levels so a circular cause can't blow up the log line.
function serializeCauseChain(err) {
  const chain = [];
  let current = err?.cause;
  for (let i = 0; i < 5 && current; i++) {
    chain.push({
      name: current?.name,
      message: current?.message,
      code: current?.code ?? current?.$metadata?.httpStatusCode,
      stack: current?.stack,
    });
    current = current?.cause;
  }
  return chain.length > 0 ? chain : undefined;
}
