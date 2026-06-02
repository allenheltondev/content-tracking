import { ApiError, type ApiFetch } from '../auth/useApiFetch';
import type { EngagementRecommendation } from './types';

// Engagement recommendations for a single content post. Generation calls
// Bedrock and is the expensive part, so it's explicit (POST); the most
// recently generated set can be re-read cheaply (GET).

// The most recently generated recommendation set for a content post, or null
// when none has been generated yet (the API answers 404 in that case).
export async function getEngagementRecommendation(
  apiFetch: ApiFetch,
  campaignId: string,
  postId: string,
): Promise<EngagementRecommendation | null> {
  try {
    return await apiFetch<EngagementRecommendation>(
      `/campaigns/${campaignId}/content-posts/${postId}/recommendations`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// Generates a fresh set of recommendations and stores them on the post. The
// optional free-text goal steers the model (e.g. "we want developer signups,
// not vanity reach").
export async function generateEngagementRecommendation(
  apiFetch: ApiFetch,
  campaignId: string,
  postId: string,
  goal?: string,
): Promise<EngagementRecommendation> {
  return apiFetch<EngagementRecommendation>(
    `/campaigns/${campaignId}/content-posts/${postId}/recommendations`,
    {
      method: 'POST',
      body: goal && goal.trim().length > 0 ? { goal: goal.trim() } : {},
    },
  );
}
