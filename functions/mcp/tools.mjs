import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listCampaigns } from "../../api/domain/campaign.mjs";
import { listVendors } from "../../api/domain/vendor.mjs";
import {
  createTenantCampaign,
  markCampaignPaid,
  setCampaignStatus,
} from "../../api/services/campaign-actions.mjs";
import { ApiError } from "../../api/services/errors.mjs";
import { withKeyedIdempotency } from "../../api/services/idempotency.mjs";
import { logger } from "../../api/services/logger.mjs";
import { decodeCursor, encodeCursor } from "../../api/services/pagination.mjs";
import { CAMPAIGN_STATUSES, formatCampaign, validateCampaignCreate } from "../../api/validation/campaign.mjs";
import { applyPaidAtDefault, validatePayoutPayload } from "../../api/validation/payout.mjs";
import { formatVendor } from "../../api/validation/vendor.mjs";

// Tool definitions for the Booked MCP server. The zod schemas describe each
// tool's arguments to the model and catch type errors early; the existing
// api/validation functions stay the authority on field rules, so a rule
// changes in one place. Every tool is bound to the tenant the authorizer
// verified, never to an argument.

export const SERVER_INFO = { name: "booked", version: "1.0.0" };
const INSTRUCTIONS =
  "Manage the creator's sponsored campaigns in Booked. Use list_campaigns to find a campaign_id before updating one. Use list_vendors to find a vendor_id for create_campaign.";

const PAGE_SIZE_MAX = 100;
const ISO_DATE = z.string().describe("Date as YYYY-MM-DD.");
const statusEnum = z.enum(CAMPAIGN_STATUSES);

const campaignShape = z.looseObject({
  campaign_id: z.string(),
  name: z.string(),
  status: z.string(),
});
const vendorShape = z.looseObject({ vendor_id: z.string(), name: z.string() });
const campaignResult = z.object({ campaign: campaignShape });

export function buildServer(tenantId) {
  if (!tenantId) {
    // Fail closed: a server without a tenant would have nothing to scope by.
    throw new Error("buildServer requires the caller's tenantId");
  }
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description: "List the creator's campaigns, newest first. Filter by status and page with cursor.",
      inputSchema: z.object({
        status: statusEnum.optional(),
        limit: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
        cursor: z.string().optional().describe("next_cursor from a previous call."),
      }),
      outputSchema: z.object({ campaigns: z.array(campaignShape), next_cursor: z.string().nullable() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ status, limit, cursor }) => {
      const { items, lastEvaluatedKey } = await listCampaigns({
        limit: limit ?? 25,
        exclusiveStartKey: decodeCursor(cursor),
        status,
        tenantId,
      });
      return { campaigns: items.map(formatCampaign), next_cursor: encodeCursor(lastEvaluatedKey) };
    }),
  );

  server.registerTool(
    "list_vendors",
    {
      title: "List vendors",
      description: "List the creator's vendors (sponsors), newest first. Use a vendor_id to link a new campaign.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
        cursor: z.string().optional().describe("next_cursor from a previous call."),
      }),
      outputSchema: z.object({ vendors: z.array(vendorShape), next_cursor: z.string().nullable() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ limit, cursor }) => {
      const { items, lastEvaluatedKey } = await listVendors({
        limit: limit ?? 25,
        exclusiveStartKey: decodeCursor(cursor),
        tenantId,
      });
      return { vendors: items.map(formatVendor), next_cursor: encodeCursor(lastEvaluatedKey) };
    }),
  );

  server.registerTool(
    "create_campaign",
    {
      title: "Create campaign",
      description:
        "Create a sponsored campaign. Status defaults to active. Pass idempotency_key so a retried call returns the same campaign.",
      inputSchema: z.object({
        name: z.string().min(1),
        sponsor: z.string().optional().describe("Sponsor display name. Defaults to the vendor's name."),
        vendor_id: z.string().optional(),
        status: statusEnum.optional(),
        startDate: ISO_DATE.optional(),
        endDate: ISO_DATE.optional(),
        deliverable_type: z.enum(["blog", "youtube"]).optional(),
        blog_url: z.string().optional(),
        youtube_url: z.string().optional(),
        payout: z
          .object({
            amount: z.number().min(0),
            currency: z.string().optional().describe("ISO 4217 code. Defaults to USD."),
            invoice_ref: z.string().optional(),
          })
          .optional(),
        idempotency_key: z.string().min(1).max(128).optional(),
      }),
      outputSchema: campaignResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ idempotency_key: idempotencyKey, payout, ...body }) => {
      const fields = validateCampaignCreate(body);
      if (payout) {
        fields.payout = applyPaidAtDefault(validatePayoutPayload(payout, { partial: false }));
      }
      const item = idempotencyKey
        ? await createIdempotent({ tenantId, idempotencyKey, fields })
        : await createTenantCampaign(tenantId, fields);
      return { campaign: formatCampaign(item) };
    }),
  );

  server.registerTool(
    "update_campaign_status",
    {
      title: "Update campaign status",
      description: "Move a campaign to draft, active, monitoring, or completed.",
      inputSchema: z.object({ campaign_id: z.string().min(1), status: statusEnum }),
      outputSchema: campaignResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ campaign_id: campaignId, status }) => {
      const item = await setCampaignStatus(tenantId, campaignId, status);
      return { campaign: formatCampaign(item) };
    }),
  );

  server.registerTool(
    "mark_campaign_paid",
    {
      title: "Mark campaign paid",
      description:
        "Record that a campaign's sponsor paid. paid_at defaults to today. Pass amount if the campaign has no payout amount yet.",
      inputSchema: z.object({
        campaign_id: z.string().min(1),
        paid_at: ISO_DATE.optional(),
        invoice_ref: z.string().optional(),
        amount: z.number().min(0).optional(),
        currency: z.string().optional().describe("ISO 4217 code. Defaults to USD."),
      }),
      outputSchema: campaignResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ campaign_id: campaignId, paid_at: paidAt, invoice_ref: invoiceRef, amount, currency }) => {
      const item = await markCampaignPaid(tenantId, campaignId, { paidAt, invoiceRef, amount, currency });
      return { campaign: formatCampaign(item) };
    }),
  );

  return server;
}

// The idempotency record caches the stored row, so a retry with the same
// key and arguments returns the campaign the first call created.
const createIdempotent = withKeyedIdempotency(({ tenantId, fields }) => createTenantCampaign(tenantId, fields));

// Wraps a tool body so it returns structuredContent plus a JSON text block,
// and turns failures into isError results the model can read and act on.
// Typed API errors carry a safe message. Anything else is logged and
// reported generically so internals never reach the client.
export function guarded(fn) {
  return async (args) => {
    try {
      const data = await fn(args);
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    } catch (err) {
      return toolError(err);
    }
  };
}

function toolError(err) {
  let message;
  if (err instanceof ApiError) {
    message = err.message;
  } else if (err?.name === "IdempotencyValidationError") {
    message = "idempotency_key was already used with different arguments.";
  } else if (err?.name === "IdempotencyAlreadyInProgressError") {
    message = "A call with this idempotency_key is still running. Retry shortly.";
  } else {
    logger.error("MCP tool failed", { error: err });
    message = "Internal error. Try again later.";
  }
  return { content: [{ type: "text", text: message }], isError: true };
}
