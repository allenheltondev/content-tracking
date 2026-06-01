import { BadRequestError } from "../services/errors.mjs";

// Generating recommendations needs no input beyond the path — the work item
// and its distribution history are read server-side. The request body is
// optional and carries only an optional free-text `goal` the caller can use
// to steer the model (e.g. "we want developer signups, not vanity reach").

const GOAL_MAX = 500;

export function validateRecommendationRequest(body) {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const { goal } = body;
  const out = {};
  if (goal !== undefined && goal !== null) {
    if (typeof goal !== "string" || goal.length > GOAL_MAX) {
      throw new BadRequestError(`goal must be a string up to ${GOAL_MAX} chars`);
    }
    if (goal.trim().length > 0) out.goal = goal.trim();
  }
  return out;
}

export const formatEngagementRecommendation = (row) => ({
  campaign_id: row.campaignId,
  post_id: row.postId,
  summary: row.summary ?? null,
  recommendations: (row.recommendations ?? []).map((r) => ({
    channel: r.channel,
    action: r.action,
    priority: r.priority,
    rationale: r.rationale,
    suggested_message: r.suggested_message,
  })),
  already_covered: row.alreadyCovered ?? [],
  generated_at: row.generatedAt,
});
