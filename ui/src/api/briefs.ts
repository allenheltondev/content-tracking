import type { ApiFetch } from '../auth/useApiFetch';
import type { BriefResponse, ChatEntry, UploadUrlResponse } from './types';

export async function requestBriefUploadUrl(
  apiFetch: ApiFetch,
  campaignId: string,
): Promise<UploadUrlResponse> {
  return apiFetch<UploadUrlResponse>(`/campaigns/${campaignId}/brief/upload-url`, {
    method: 'POST',
  });
}

// Uploads a PDF File directly to S3 via the presigned URL. This bypasses
// API Gateway's 6MB payload cap and avoids touching the backend Lambda
// for raw bytes.
export async function uploadPdf(uploadUrl: string, file: File): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: file,
  });
  if (!response.ok) {
    throw new Error(`PDF upload failed with HTTP ${response.status}`);
  }
}

export async function submitChatBrief(
  apiFetch: ApiFetch,
  campaignId: string,
  conversation: ChatEntry[],
): Promise<BriefResponse> {
  return apiFetch<BriefResponse>(`/campaigns/${campaignId}/brief`, {
    method: 'POST',
    body: { source_type: 'chat', conversation },
  });
}

export async function submitPdfBrief(
  apiFetch: ApiFetch,
  campaignId: string,
): Promise<BriefResponse> {
  return apiFetch<BriefResponse>(`/campaigns/${campaignId}/brief`, {
    method: 'POST',
    body: { source_type: 'pdf' },
  });
}
