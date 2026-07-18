import { BadRequestError } from "../services/errors.mjs";

// Validation + response formatting for the content review feature. Request and
// response bodies are snake_case (matching validation/content.mjs); internal
// storage is camelCase. Throws BadRequestError on any rule violation so route
// handlers let it propagate to the error mapper.

// The five review lenses' suggestion types, carried through from the agents
// that produce them. `brand` is the on-voice lens, which is grounded in the
// existing Voice profile rather than a separate learned model.
export const SUGGESTION_TYPES = ["llm", "brand", "fact", "grammar", "spelling"];
export const SUGGESTION_PRIORITIES = ["low", "medium", "high"];

// Statuses a client may set on a suggestion. `skipped` is system-only (set by
// cross-edit revalidation when the underlying text is gone), so it is not an
// accepted input here.
const CLIENT_SETTABLE_STATUSES = ["accepted", "rejected", "dismissed"];

function requireObject(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }
}

// POST /content/{id}/reviews — the request body is optional. `platform`
// (optional) tells the on-voice lens which Voice profile to grade against;
// absent means the content's own platform / default.
export function validateStartReview(body) {
  if (body === undefined || body === null) return {};
  requireObject(body);
  const out = {};
  if (body.platform !== undefined) {
    if (typeof body.platform !== "string" || body.platform.trim().length === 0) {
      throw new BadRequestError("platform must be a non-empty string when provided");
    }
    out.platform = body.platform.trim();
  }
  return out;
}

// POST /content/{id}/suggestions/{sid}/status — { status } in the client-
// settable set.
export function validateSuggestionStatusUpdate(body) {
  requireObject(body);
  const { status } = body;
  if (typeof status !== "string" || !CLIENT_SETTABLE_STATUSES.includes(status)) {
    throw new BadRequestError(`status must be one of ${CLIENT_SETTABLE_STATUSES.join(", ")}`);
  }
  return { status };
}

// Shapes a stored suggestion row into its snake_case API form. Exposes the
// re-derived offsets and the anchor/context the editor needs to render and
// re-locate the highlight, but not the storage keys.
export function formatSuggestion(item) {
  return {
    id: item.suggestionId,
    review_id: item.reviewId ?? null,
    type: item.type,
    priority: item.priority,
    reason: item.reason,
    status: item.status,
    start_offset: item.startOffset,
    end_offset: item.endOffset,
    text_to_replace: item.anchorText,
    replace_with: item.replaceWith ?? "",
    context_before: item.contextBefore ?? "",
    context_after: item.contextAfter ?? "",
    created_at: item.createdAt,
  };
}

// Shapes a stored review row into its snake_case API form.
export function formatReview(item) {
  if (!item) return null;
  return {
    id: item.reviewId,
    status: item.status,
    summary: item.summary ?? null,
    lenses: item.lenses ?? null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}
