import { McpServer } from "@modelcontextprotocol/server";
import { registerCampaignTools } from "./tools/campaigns.mjs";
import { registerDeliverableTools } from "./tools/deliverables.mjs";
import { registerReportingTools } from "./tools/reporting.mjs";
import { registerVendorTools } from "./tools/vendors.mjs";
import { registerWorkflowTools } from "./tools/workflow.mjs";

export const SERVER_INFO = { name: "booked", version: "2.0.0" };

const INSTRUCTIONS = [
  "Manage the creator's sponsored campaigns in Booked.",
  "Find ids with list_campaigns and list_vendors. get_campaign returns a campaign with its links, posts, brief, and draft.",
  "Campaign status follows a lifecycle (draft, active, monitoring, completed); update_campaign_status lists the allowed moves.",
  "Pass idempotency_key on create and add tools so a retry never creates a duplicate.",
].join(" ");

// Builds a server for one request, bound to the tenant the authorizer
// verified. `publicReportUrl(token)` turns a campaign's stable report token
// into its public link on the API host the request came in on.
export function buildServer({ tenantId, publicReportUrl } = {}) {
  if (!tenantId) {
    // Fail closed: a server without a tenant would have nothing to scope by.
    throw new Error("buildServer requires the caller's tenantId");
  }
  const ctx = { tenantId, publicReportUrl: publicReportUrl ?? (() => null) };
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerCampaignTools(server, ctx);
  registerVendorTools(server, ctx);
  registerDeliverableTools(server, ctx);
  registerWorkflowTools(server, ctx);
  registerReportingTools(server, ctx);
  return server;
}
