import type { ApiFetch } from '../auth/useApiFetch';
import type {
  AddPublishVariantParams,
  Campaign,
  Content,
  ContentAnalyticsResponse,
  ContentAnswer,
  ContentListResponse,
  ContentPublishVariant,
  ContentStatsSnapshot,
  ContentType,
  CreateContentParams,
  CrosspostPlatform,
  UpdateContentParams,
} from './types';

// Unified Content catalog: management (CRUD) plus RAG Q&A (askContent). All
// scoped server-side to the signed-in creator's partition. This is the
// management successor to the retired Blog catalog client.

export const CROSSPOST_PLATFORMS: CrosspostPlatform[] = ['dev', 'medium', 'hashnode'];

// Optional server-side filters for GET /content. Omitted/empty values are
// dropped by apiFetch's query serializer so they don't constrain the list.
export interface ListContentParams {
  type?: ContentType;
  source?: string;
  status?: string;
  startKey?: string;
}

export async function listContent(
  apiFetch: ApiFetch,
  params: ListContentParams = {},
): Promise<ContentListResponse> {
  return apiFetch<ContentListResponse>('/content', {
    query: {
      type: params.type,
      source: params.source,
      status: params.status,
      startKey: params.startKey,
    },
  });
}

export async function getContent(apiFetch: ApiFetch, contentId: string): Promise<Content> {
  return apiFetch<Content>(`/content/${contentId}`);
}

export async function createContent(apiFetch: ApiFetch, params: CreateContentParams): Promise<Content> {
  return apiFetch<Content>('/content', { method: 'POST', body: params });
}

export async function updateContent(
  apiFetch: ApiFetch,
  contentId: string,
  params: UpdateContentParams,
): Promise<Content> {
  return apiFetch<Content>(`/content/${contentId}`, { method: 'PATCH', body: params });
}

export async function deleteContent(apiFetch: ApiFetch, contentId: string): Promise<void> {
  await apiFetch(`/content/${contentId}`, { method: 'DELETE' });
}

// --- Sponsorship: the campaign that hangs off a content piece (1:1) ----------

// The campaign attached to this piece, or null when it's an unsponsored
// creation (the API returns 404, which we translate to null).
export async function getContentCampaign(apiFetch: ApiFetch, contentId: string): Promise<Campaign | null> {
  try {
    return await apiFetch<Campaign>(`/content/${contentId}/campaign`);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

// Attach an existing campaign to a content piece.
export async function attachContentCampaign(
  apiFetch: ApiFetch,
  contentId: string,
  campaignId: string,
): Promise<Content> {
  return apiFetch<Content>(`/content/${contentId}/campaign`, {
    method: 'PUT',
    body: { campaign_id: campaignId },
  });
}

// Create a new campaign and attach it in one step (create content → sponsor it).
export async function createContentSponsorship(
  apiFetch: ApiFetch,
  contentId: string,
  params: { name: string },
): Promise<Campaign> {
  return apiFetch<Campaign>(`/content/${contentId}/campaign`, { method: 'POST', body: params });
}

// Detach the sponsorship, leaving an unsponsored piece (the campaign survives).
export async function detachContentCampaign(apiFetch: ApiFetch, contentId: string): Promise<void> {
  await apiFetch(`/content/${contentId}/campaign`, { method: 'DELETE' });
}

// --- Publishing + analytics --------------------------------------------------

export async function getContentAnalytics(apiFetch: ApiFetch, contentId: string): Promise<ContentAnalyticsResponse> {
  return apiFetch<ContentAnalyticsResponse>(`/content/${contentId}/analytics`);
}

export async function addPublishVariant(
  apiFetch: ApiFetch,
  contentId: string,
  params: AddPublishVariantParams,
): Promise<ContentPublishVariant> {
  return apiFetch<ContentPublishVariant>(`/content/${contentId}/publish`, { method: 'POST', body: params });
}

export async function recordContentStats(
  apiFetch: ApiFetch,
  contentId: string,
  platform: string,
  metrics: Record<string, number>,
): Promise<ContentStatsSnapshot> {
  return apiFetch<ContentStatsSnapshot>(`/content/${contentId}/stats/${encodeURIComponent(platform)}`, {
    method: 'PUT',
    body: { metrics },
  });
}

export interface CrosspostContentResult {
  platform: string;
  status: 'succeeded' | 'failed' | 'skipped';
  url?: string;
  error?: string;
}

// Cross-post a content piece (dev/medium/hashnode) off the Content row, so
// content-native pieces can publish. Records each success as a publish variant.
export async function crosspostContent(
  apiFetch: ApiFetch,
  contentId: string,
  platforms: string[],
): Promise<{ content_id: string; results: CrosspostContentResult[] }> {
  return apiFetch(`/content/${contentId}/crosspost`, { method: 'POST', body: { platforms } });
}

// --- RAG Q&A -----------------------------------------------------------------

export interface AskContentParams {
  question: string;
  // How many chunks to retrieve (1-20). Omit for the server default.
  topK?: number;
  // Restrict the search to a single piece of content instead of the catalog.
  contentId?: string;
  // Restrict the search to a single content type.
  type?: ContentType;
}

export async function askContent(apiFetch: ApiFetch, params: AskContentParams): Promise<ContentAnswer> {
  return apiFetch<ContentAnswer>('/content/ask', {
    method: 'POST',
    body: {
      question: params.question,
      ...(params.topK !== undefined ? { top_k: params.topK } : {}),
      ...(params.contentId ? { content_id: params.contentId } : {}),
      ...(params.type ? { type: params.type } : {}),
    },
  });
}
