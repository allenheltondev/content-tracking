import type { ApiFetch } from '../auth/useApiFetch';

// Client for the content review feature: start a review, poll its status, and
// walk the offset-anchored suggestions it produces (accept / reject / dismiss).
// The API speaks snake_case; we map to camelCase at this boundary so the rest
// of the UI (and the offset engine) works in one idiom.

export type SuggestionType = 'llm' | 'brand' | 'fact' | 'grammar' | 'spelling';
export type SuggestionPriority = 'low' | 'medium' | 'high';
export type SuggestionDecision = 'accepted' | 'rejected' | 'dismissed';
export type ReviewStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface Suggestion {
  id: string;
  reviewId: string | null;
  type: SuggestionType;
  priority: SuggestionPriority;
  reason: string;
  startOffset: number;
  endOffset: number;
  textToReplace: string;
  replaceWith: string;
  contextBefore: string;
  contextAfter: string;
  createdAt: string;
}

export interface ReviewLenses {
  verdict?: string | null;
  counts?: Record<string, number>;
  failed?: string[];
  recorded?: number;
}

export interface Review {
  id: string;
  status: ReviewStatus;
  summary: string | null;
  lenses: ReviewLenses | null;
  createdAt: string;
  updatedAt: string;
}

interface SuggestionDTO {
  id: string;
  review_id: string | null;
  type: SuggestionType;
  priority: SuggestionPriority;
  reason: string;
  status: string;
  start_offset: number;
  end_offset: number;
  text_to_replace: string;
  replace_with: string;
  context_before: string;
  context_after: string;
  created_at: string;
}

interface ReviewDTO {
  id: string;
  status: ReviewStatus;
  summary: string | null;
  lenses: ReviewLenses | null;
  created_at: string;
  updated_at: string;
}

function toSuggestion(d: SuggestionDTO): Suggestion {
  return {
    id: d.id,
    reviewId: d.review_id,
    type: d.type,
    priority: d.priority,
    reason: d.reason,
    startOffset: d.start_offset,
    endOffset: d.end_offset,
    textToReplace: d.text_to_replace,
    replaceWith: d.replace_with,
    contextBefore: d.context_before,
    contextAfter: d.context_after,
    createdAt: d.created_at,
  };
}

function toReview(d: ReviewDTO | null): Review | null {
  if (!d) return null;
  return {
    id: d.id,
    status: d.status,
    summary: d.summary,
    lenses: d.lenses,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

// Kick off a review of the current draft. Returns the pending review (202); the
// engine fills in suggestions + summary asynchronously.
export async function startReview(apiFetch: ApiFetch, contentId: string, platform?: string): Promise<Review> {
  const dto = await apiFetch<ReviewDTO>(`/content/${contentId}/reviews`, {
    method: 'POST',
    body: platform ? { platform } : undefined,
  });
  return toReview(dto)!;
}

// Poll a review's status (and, on completion, its summary).
export async function getReview(apiFetch: ApiFetch, contentId: string, reviewId: string): Promise<Review> {
  return toReview(await apiFetch<ReviewDTO>(`/content/${contentId}/reviews/${reviewId}`))!;
}

// The pending suggestions for a piece of content plus the latest review summary.
export async function getSuggestions(
  apiFetch: ApiFetch,
  contentId: string,
): Promise<{ suggestions: Suggestion[]; review: Review | null }> {
  const res = await apiFetch<{ suggestions: SuggestionDTO[]; review: ReviewDTO | null }>(
    `/content/${contentId}/suggestions`,
  );
  return { suggestions: (res.suggestions ?? []).map(toSuggestion), review: toReview(res.review) };
}

// Record a decision on a suggestion (accepted / rejected / dismissed).
export async function updateSuggestionStatus(
  apiFetch: ApiFetch,
  contentId: string,
  suggestionId: string,
  status: SuggestionDecision,
): Promise<void> {
  await apiFetch(`/content/${contentId}/suggestions/${suggestionId}/status`, {
    method: 'POST',
    body: { status },
  });
}
