import { z } from "zod";
import {
  assertVendorOwned,
  createVendor,
  listCampaignsForVendor,
  listVendors,
  updateVendor,
} from "../../../api/domain/vendor.mjs";
import { BadRequestError } from "../../../api/services/errors.mjs";
import { runOnce } from "../../../api/services/idempotency.mjs";
import { decodeCursor, encodeCursor } from "../../../api/services/pagination.mjs";
import {
  formatVendor,
  formatVendorCampaign,
  validateVendorPayload,
} from "../../../api/validation/vendor.mjs";
import {
  PAGE_SIZE_DEFAULT,
  READ,
  UPDATE,
  WRITE,
  guarded,
  id,
  idempotencyKey,
  pageArgs,
  vendorShape,
} from "../shared.mjs";

// Vendors are the sponsors a campaign links to. Delete is left to the
// dashboard: it removes the vendor's campaign index for every campaign.
const vendorFields = {
  website: z.string().optional(),
  contact_name: z.string().optional(),
  contact_email: z.string().optional(),
  payment_terms: z.string().optional().describe("For example, net 30."),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
};

export function registerVendorTools(server, { tenantId }) {
  server.registerTool(
    "list_vendors",
    {
      title: "List vendors",
      description: "List the creator's vendors (sponsors), newest first.",
      inputSchema: z.object(pageArgs),
      outputSchema: z.object({ vendors: z.array(vendorShape), next_cursor: z.string().nullable() }),
      annotations: READ,
    },
    guarded(async ({ limit, cursor }) => {
      const { items, lastEvaluatedKey } = await listVendors({
        limit: limit ?? PAGE_SIZE_DEFAULT,
        exclusiveStartKey: decodeCursor(cursor),
        tenantId,
      });
      return { vendors: items.map(formatVendor), next_cursor: encodeCursor(lastEvaluatedKey) };
    }),
  );

  server.registerTool(
    "get_vendor",
    {
      title: "Get vendor",
      description: "Get one vendor and the campaigns linked to it, newest first.",
      inputSchema: z.object({ vendor_id: id("vendor") }),
      outputSchema: z.object({ vendor: vendorShape, campaigns: z.array(z.looseObject({})) }),
      annotations: READ,
    },
    guarded(async ({ vendor_id: vendorId }) => {
      const vendor = await assertVendorOwned(vendorId, tenantId);
      const campaigns = (await listCampaignsForVendor(vendorId, tenantId))
        .map(formatVendorCampaign)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { vendor: formatVendor(vendor), campaigns };
    }),
  );

  server.registerTool(
    "create_vendor",
    {
      title: "Create vendor",
      description: "Add a sponsor. Pass vendor_id to choose a readable id (letters, digits, _ or -); one is generated otherwise.",
      inputSchema: z.object({
        name: z.string().min(1),
        vendor_id: z.string().optional(),
        ...vendorFields,
        idempotency_key: idempotencyKey,
      }),
      outputSchema: z.object({ vendor: vendorShape }),
      annotations: WRITE,
    },
    guarded(async ({ idempotency_key: key, ...body }) => {
      const fields = validateVendorPayload(body, { requireName: true, allowVendorId: true });
      const item = await runOnce({
        operation: "create_vendor",
        tenantId,
        idempotencyKey: key,
        fields,
        run: () => createVendor({ ...fields, tenantId }),
      });
      return { vendor: formatVendor(item) };
    }),
  );

  server.registerTool(
    "update_vendor",
    {
      title: "Update vendor",
      description: "Edit a vendor. Only the fields you pass change.",
      inputSchema: z.object({ vendor_id: id("vendor"), name: z.string().min(1).optional(), ...vendorFields }),
      outputSchema: z.object({ vendor: vendorShape }),
      annotations: UPDATE,
    },
    guarded(async ({ vendor_id: vendorId, ...body }) => {
      const fields = validateVendorPayload(body, { requireName: false });
      if (Object.keys(fields).length === 0) {
        throw new BadRequestError("Pass at least one field to change.");
      }
      await assertVendorOwned(vendorId, tenantId);
      return { vendor: formatVendor(await updateVendor(vendorId, fields)) };
    }),
  );
}
