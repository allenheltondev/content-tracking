import type { ApiFetch } from '../auth/useApiFetch';
import { env } from '../auth/config';

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

// --- Live streaming (Function URL) -------------------------------------------

// Progress events streamed by the review Function URL (see review-runner.mjs).
export type ReviewStreamEvent =
  | { type: 'review'; review: Review }
  | { type: 'status'; lens: string; state: 'running' }
  | { type: 'lens'; name: string; count: number; ok?: boolean }
  | { type: 'suggestions'; suggestions: Suggestion[] }
  | { type: 'summary'; summary: string | null; verdict: string | null }
  | { type: 'done'; status: ReviewStatus }
  | { type: 'error'; message: string };

export function reviewStreamingEnabled(): boolean {
  return typeof env.reviewStreamBaseUrl === 'string' && env.reviewStreamBaseUrl.length > 0;
}

// Opens the live review stream: the server creates the review, runs the lenses,
// and streams progress + the recorded suggestions as NDJSON. Each event is
// handed to `onEvent`. Throws on transport failure or a terminal `error` event
// so the caller can fall back to the buffered start-review + poll path.
export async function streamReview(
  token: string,
  contentId: string,
  platform: string | undefined,
  onEvent: (event: ReviewStreamEvent) => void,
): Promise<void> {
  if (!env.reviewStreamBaseUrl) throw new Error('Review streaming is not configured');

  const res = await fetch(env.reviewStreamBaseUrl, {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify({ contentId, ...(platform ? { platform } : {}) }),
  });
  if (!res.ok || !res.body) throw new Error(`Review stream failed (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;

      const raw = JSON.parse(line);
      if (raw.type === 'suggestions') {
        onEvent({ type: 'suggestions', suggestions: (raw.suggestions ?? []).map(toSuggestion) });
      } else if (raw.type === 'review') {
        onEvent({ type: 'review', review: toReview(raw.review)! });
      } else if (raw.type === 'error') {
        onEvent(raw as ReviewStreamEvent);
        throw new Error(raw.message ?? 'Review failed');
      } else {
        onEvent(raw as ReviewStreamEvent);
      }
    }
  }
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
