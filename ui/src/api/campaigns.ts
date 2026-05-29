import type { ApiFetch } from '../auth/useApiFetch';
import type {
  Campaign,
  CampaignAnalyticsResponse,
  CampaignDetailResponse,
  CampaignDraft,
  CampaignLink,
  CampaignListResponse,
  CampaignReportResponse,
  CampaignReportsListResponse,
  CampaignStatus,
  ContentPost,
  ContentPostSnapshotsResponse,
  CreateCampaignRequest,
  CreateContentPostRequest,
  CreateLinkRequest,
  CreateSocialPostRequest,
  SaveDraftRequest,
  SocialPost,
  SocialPostSnapshotsResponse,
  UpdateCampaignRequest,
  WebAnalyticsResponse,
} from './types';

export async function listCampaigns(
  apiFetch: ApiFetch,
  options: { status?: CampaignStatus; limit?: number; startKey?: string } = {},
): Promise<CampaignListResponse> {
  return apiFetch<CampaignListResponse>('/campaigns', {
    query: {
      status: options.status,
      limit: options.limit ?? 100,
      startKey: options.startKey,
    },
  });
}

export async function getCampaign(
  apiFetch: ApiFetch,
  campaignId: string,
): Promise<CampaignDetailResponse> {
  return apiFetch<CampaignDetailResponse>(`/campaigns/${campaignId}`);
}

export async function getCampaignAnalytics(
  apiFetch: ApiFetch,
  campaignId: string,
): Promise<CampaignAnalyticsResponse> {
  return apiFetch<CampaignAnalyticsResponse>(`/campaigns/${campaignId}/analytics`);
}

export async function getCampaignWebAnalytics(
  apiFetch: ApiFetch,
  campaignId: string,
): Promise<WebAnalyticsResponse> {
  return apiFetch<WebAnalyticsResponse>(`/campaigns/${campaignId}/web-analytics`);
}

export async function createCampaign(
  apiFetch: ApiFetch,
  payload: CreateCampaignRequest,
): Promise<Campaign> {
  return apiFetch<Campaign>('/campaigns', { method: 'POST', body: payload });
}

export async function updateCampaign(
  apiFetch: ApiFetch,
  campaignId: string,
  payload: UpdateCampaignRequest,
): Promise<Campaign> {
  return apiFetch<Campaign>(`/campaigns/${campaignId}`, { method: 'PATCH', body: payload });
}

export async function createLink(
  apiFetch: ApiFetch,
  campaignId: string,
  payload: CreateLinkRequest,
): Promise<CampaignLink> {
  return apiFetch<CampaignLink>(`/campaigns/${campaignId}/links`, {
    method: 'POST',
    body: payload,
  });
}

export async function createSocialPost(
  apiFetch: ApiFetch,
  campaignId: string,
  payload: CreateSocialPostRequest,
): Promise<SocialPost> {
  return apiFetch<SocialPost>(`/campaigns/${campaignId}/social-posts`, {
    method: 'POST',
    body: payload,
  });
}

export async function saveDraft(
  apiFetch: ApiFetch,
  campaignId: string,
  payload: SaveDraftRequest,
): Promise<CampaignDraft> {
  return apiFetch<CampaignDraft>(`/campaigns/${campaignId}/draft`, {
    method: 'POST',
    body: payload,
  });
}

export async function reviewDraft(
  apiFetch: ApiFetch,
  campaignId: string,
): Promise<CampaignDraft> {
  return apiFetch<CampaignDraft>(`/campaigns/${campaignId}/draft/review`, {
    method: 'POST',
  });
}

export async function getSocialPostSnapshots(
  apiFetch: ApiFetch,
  campaignId: string,
  postId: string,
): Promise<SocialPostSnapshotsResponse> {
  return apiFetch<SocialPostSnapshotsResponse>(
    `/campaigns/${campaignId}/social-posts/${postId}/snapshots`,
  );
}

export async function deleteSocialPost(
  apiFetch: ApiFetch,
  campaignId: string,
  postId: string,
): Promise<void> {
  await apiFetch<void>(`/campaigns/${campaignId}/social-posts/${postId}`, {
    method: 'DELETE',
  });
}

export async function createContentPost(
  apiFetch: ApiFetch,
  campaignId: string,
  payload: CreateContentPostRequest,
): Promise<ContentPost> {
  return apiFetch<ContentPost>(`/campaigns/${campaignId}/content-posts`, {
    method: 'POST',
    body: payload,
  });
}

// Generates a frozen campaign performance report and returns a CloudFront
// signed link to its static HTML. No request body is needed; the server
// freezes the data as of generation time.
export async function generateCampaignReport(
  apiFetch: ApiFetch,
  campaignId: string,
): Promise<CampaignReportResponse> {
  return apiFetch<CampaignReportResponse>(`/campaigns/${campaignId}/report`, {
    method: 'POST',
    body: {},
  });
}

export async function listCampaignReports(
  apiFetch: ApiFetch,
  campaignId: string,
): Promise<CampaignReportsListResponse> {
  return apiFetch<CampaignReportsListResponse>(`/campaigns/${campaignId}/reports`);
}

export async function getContentPostSnapshots(
  apiFetch: ApiFetch,
  campaignId: string,
  postId: string,
): Promise<ContentPostSnapshotsResponse> {
  return apiFetch<ContentPostSnapshotsResponse>(
    `/campaigns/${campaignId}/content-posts/${postId}/snapshots`,
  );
}

export async function deleteContentPost(
  apiFetch: ApiFetch,
  campaignId: string,
  postId: string,
): Promise<void> {
  await apiFetch<void>(`/campaigns/${campaignId}/content-posts/${postId}`, {
    method: 'DELETE',
  });
}
