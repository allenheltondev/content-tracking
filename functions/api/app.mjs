import { Router } from "@aws-lambda-powertools/event-handler/http";
import { registerVendorRoutes } from "./routes/vendors.mjs";
import { registerCampaignRoutes } from "./routes/campaigns.mjs";
import { registerLinkRoutes } from "./routes/links.mjs";
import { registerAnalyticsRoutes } from "./routes/analytics.mjs";
import { registerPayoutRoutes } from "./routes/payout.mjs";
import { registerRevenueRoutes } from "./routes/revenue.mjs";
import { registerBriefRoutes } from "./routes/briefs.mjs";
import { logger } from "./services/logger.mjs";
import { jsonResponse } from "./services/http-handler.mjs";

export const app = new Router();

registerVendorRoutes(app);
registerCampaignRoutes(app);
registerLinkRoutes(app);
registerAnalyticsRoutes(app);
registerPayoutRoutes(app);
registerRevenueRoutes(app);
registerBriefRoutes(app);

app.notFound(({ event }) => {
  const method = event.httpMethod || event?.requestContext?.http?.method;
  const path = event.path || event?.requestContext?.http?.path;
  logger.warn("Route not matched", { method, path });
  return jsonResponse(404, { message: `No route registered for ${method} ${path}` });
});
