import { z } from "zod";
import { getCampaignWithLinks, listCampaigns, assertCampaignOwned } from "../../../api/domain/campaign.mjs";
import {
  createTenantCampaign,
  markCampaignPaid,
  setCampaignStatus,
  updateTenantCampaign,
  updateTenantCampaignPayout,
} from "../../../api/services/campaign-actions.mjs";
import { BadRequestError } from "../../../api/services/errors.mjs";
import { runOnce } from "../../../api/services/idempotency.mjs";
import { decodeCursor, encodeCursor } from "../../../api/services/pagination.mjs";
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_STATUS_TRANSITIONS,
  formatCampaign,
  formatCampaignDetail,
  validateCampaignCreate,
  validateCampaignUpdate,
} from "../../../api/validation/campaign.mjs";
import { applyPaidAtDefault, validatePayoutPayload } from "../../../api/validation/payout.mjs";
import {
  PAGE_SIZE_DEFAULT,
  READ,
  UPDATE,
  WRITE,
  campaignResult,
  campaignShape,
  guarded,
  id,
  idempotencyKey,
  isoDate,
  pageArgs,
} from "../shared.mjs";

const statusEnum = z.enum(CAMPAIGN_STATUSES);
const currency = z.string().optional().describe("ISO 4217 code. Defaults to USD.");
const lifecycle = Object.entries(CAMPAIGN_STATUS_TRANSITIONS)
  .map(([from, to]) => `${from} -> ${to.length ? to.join(" or ") : "nothing (final)"}`)
  .join("; ");

// Fields a campaign carries besides status and payout, which have their
// own tools. Shared by create and update.
const campaignFields = {
  sponsor: z.string().optional().describe("Sponsor display name. Defaults to the vendor's name."),
  vendor_id: z.string().optional().describe("Link to a vendor from list_vendors."),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  deliverable_type: z.enum(["blog", "youtube"]).optional().describe("The main deliverable. Defaults to blog."),
  blog_url: z.string().optional().describe("Published blog post URL, used for GA4 and Core Web Vitals."),
  youtube_url: z.string().optional().describe("Published YouTube video URL, used for video stats."),
  link_tracking_id: z.string().optional(),
  targetMetrics: z.record(z.string(), z.unknown()).optional().describe("Goals agreed with the sponsor."),
};

export function registerCampaignTools(server, { tenantId }) {
  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description: "List the creator's campaigns, newest first. Filter by status and page with cursor.",
      inputSchema: z.object({ status: statusEnum.optional(), ...pageArgs }),
      outputSchema: z.object({ campaigns: z.array(campaignShape), next_cursor: z.string().nullable() }),
      annotations: READ,
    },
    guarded(async ({ status, limit, cursor }) => {
      const { items, lastEvaluatedKey } = await listCampaigns({
        limit: limit ?? PAGE_SIZE_DEFAULT,
        exclusiveStartKey: decodeCursor(cursor),
        status,
        tenantId,
      });
      return { campaigns: items.map(formatCampaign), next_cursor: encodeCursor(lastEvaluatedKey) };
    }),
  );

  server.registerTool(
    "get_campaign",
    {
      title: "Get campaign",
      description:
        "Get one campaign with its tracked links, social posts, content posts (with current metrics), brief summary, and draft.",
      inputSchema: z.object({ campaign_id: id("campaign") }),
      outputSchema: z.looseObject({ campaign: campaignShape }),
      annotations: READ,
    },
    guarded(async ({ campaign_id: campaignId }) => {
      await assertCampaignOwned(campaignId, tenantId);
      return formatCampaignDetail(await getCampaignWithLinks(campaignId));
    }),
  );

  server.registerTool(
    "create_campaign",
    {
      title: "Create campaign",
      description: "Create a sponsored campaign. Status defaults to active.",
      inputSchema: z.object({
        name: z.string().min(1),
        status: statusEnum.optional(),
        ...campaignFields,
        payout: z
          .object({ amount: z.number().min(0), currency, invoice_ref: z.string().optional() })
          .optional()
          .describe("The agreed fee."),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: campaignResult,
      annotations: WRITE,
    },
    guarded(async ({ idempotency_key: key, payout, ...body }) => {
      const fields = validateCampaignCreate(body);
      if (payout) {
        fields.payout = applyPaidAtDefault(validatePayoutPayload(payout, { partial: false }));
      }
      const item = await runOnce({
        operation: "create_campaign",
        tenantId,
        idempotencyKey: key,
        fields,
        run: () => createTenantCampaign(tenantId, fields),
      });
      return { campaign: formatCampaign(item) };
    }),
  );

  server.registerTool(
    "update_campaign",
    {
      title: "Update campaign",
      description:
        "Edit a campaign's details. Only the fields you pass change. Use update_campaign_status for status and update_campaign_payout for the fee.",
      inputSchema: z.object({ campaign_id: id("campaign"), name: z.string().min(1).optional(), ...campaignFields }),
      outputSchema: campaignResult,
      annotations: UPDATE,
    },
    guarded(async ({ campaign_id: campaignId, ...body }) => {
      const fields = validateCampaignUpdate(body);
      if (Object.keys(fields).length === 0) {
        throw new BadRequestError("Pass at least one field to change.");
      }
      return { campaign: formatCampaign(await updateTenantCampaign(tenantId, campaignId, fields)) };
    }),
  );

  server.registerTool(
    "update_campaign_status",
    {
      title: "Update campaign status",
      description: `Move a campaign along its lifecycle. Allowed moves: ${lifecycle}.`,
      inputSchema: z.object({ campaign_id: id("campaign"), status: statusEnum }),
      outputSchema: campaignResult,
      annotations: UPDATE,
    },
    guarded(async ({ campaign_id: campaignId, status }) => ({
      campaign: formatCampaign(await setCampaignStatus(tenantId, campaignId, status)),
    })),
  );

  server.registerTool(
    "update_campaign_payout",
    {
      title: "Update campaign payout",
      description:
        "Change the fee, currency, invoice reference, or paid state. Setting paid to false clears paid_at. Use mark_campaign_paid to record a payment.",
      inputSchema: z.object({
        campaign_id: id("campaign"),
        amount: z.number().min(0).optional(),
        currency,
        paid: z.boolean().optional(),
        paid_at: isoDate.nullable().optional(),
        invoice_ref: z.string().nullable().optional().describe("null clears it."),
      }),
      outputSchema: campaignResult,
      annotations: UPDATE,
    },
    guarded(async ({ campaign_id: campaignId, ...payout }) => {
      const fields = validatePayoutPayload(payout, { partial: true });
      return { campaign: formatCampaign(await updateTenantCampaignPayout(tenantId, campaignId, fields)) };
    }),
  );

  server.registerTool(
    "mark_campaign_paid",
    {
      title: "Mark campaign paid",
      description:
        "Record that a campaign's sponsor paid. paid_at defaults to today. Pass amount if the campaign has no payout amount yet.",
      inputSchema: z.object({
        campaign_id: id("campaign"),
        paid_at: isoDate.optional(),
        invoice_ref: z.string().optional(),
        amount: z.number().min(0).optional(),
        currency,
      }),
      outputSchema: campaignResult,
      annotations: UPDATE,
    },
    guarded(async ({ campaign_id: campaignId, paid_at: paidAt, invoice_ref: invoiceRef, amount, currency: cur }) => ({
      campaign: formatCampaign(
        await markCampaignPaid(tenantId, campaignId, { paidAt, invoiceRef, amount, currency: cur }),
      ),
    })),
  );
}
