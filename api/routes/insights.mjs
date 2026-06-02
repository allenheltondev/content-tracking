import { jsonResponse } from "../services/http-handler.mjs";
import { parseInsightsQuery } from "../validation/insights.mjs";
import { buildInsightsSummary } from "../domain/insights.mjs";

// GET /insights?startDate=&endDate=
//
// Account-wide Trends & Insights over the creator's tracked content: an
// engagement time series (cumulative levels), top-performing posts,
// per-platform totals, and period-over-period deltas. Read-side aggregation
// over the daily snapshots already captured — no new data is written.
export function registerInsightsRoutes(app) {
  app.get("/insights", async ({ event }) => {
    const params = event.queryStringParameters || {};
    const { startDate, endDate } = parseInsightsQuery(params);
    const summary = await buildInsightsSummary({ startDate, endDate });
    return jsonResponse(200, summary);
  });
}
