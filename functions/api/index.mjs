import { app } from "./app.mjs";
import { createHttpRouterHandler } from "./services/http-handler.mjs";

// Lambda entry point. Every route — campaigns, vendors, links, analytics,
// payout, revenue — runs through this single function. Powertools Router
// dispatches based on method + path inside the wrapper.
export const handler = createHttpRouterHandler({
  app,
  handlerName: "content-tracking-api",
});
