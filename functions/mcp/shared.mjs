import { z } from "zod";
import { ApiError } from "../../api/services/errors.mjs";
import { logger } from "../../api/services/logger.mjs";

// Building blocks shared by the tool modules in ./tools. The zod schemas
// describe arguments to the model and catch type errors early; the
// api/validation functions stay the authority on field rules.

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;

export const isoDate = z.string().describe("Date as YYYY-MM-DD.");
export const id = (what) => z.string().min(1).describe(`The ${what} id.`);
export const pageArgs = {
  limit: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
  cursor: z.string().optional().describe("next_cursor from a previous call."),
};
export const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe("Any unique string. A retried call with the same key and arguments returns the first result.");

// Output shapes. Loose objects so extra response fields pass validation;
// the listed fields are the ones agents should rely on.
export const campaignShape = z.looseObject({ campaign_id: z.string(), name: z.string(), status: z.string() });
export const vendorShape = z.looseObject({ vendor_id: z.string(), name: z.string() });
export const anyObject = z.looseObject({});
export const campaignResult = z.object({ campaign: campaignShape });

// Annotation presets (hints for clients deciding when to confirm a call).
export const READ = { readOnlyHint: true, openWorldHint: false };
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const UPDATE = { ...WRITE, idempotentHint: true };
export const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// Wraps a tool body so it returns structuredContent plus the same JSON as a
// text block, and turns failures into isError results the model can read
// and act on. Typed API errors carry a safe message. Anything else is
// logged and reported generically so internals never reach the client.
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
