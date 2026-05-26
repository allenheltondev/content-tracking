import type { ApiFetch } from '../auth/useApiFetch';
import type {
  BriefDetailResponse,
  BriefResponse,
  ChatEntry,
  ConfirmRequest,
  ConfirmResponse,
  UploadUrlResponse,
} from './types';

export async function requestUploadUrl(apiFetch: ApiFetch): Promise<UploadUrlResponse> {
  return apiFetch<UploadUrlResponse>('/briefs/upload-url', { method: 'POST' });
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

export async function submitPdfBrief(
  apiFetch: ApiFetch,
  briefId: string,
): Promise<BriefResponse> {
  return apiFetch<BriefResponse>('/briefs', {
    method: 'POST',
    body: { source_type: 'pdf', brief_id: briefId },
  });
}

export async function submitChatBrief(
  apiFetch: ApiFetch,
  conversation: ChatEntry[],
): Promise<BriefResponse> {
  return apiFetch<BriefResponse>('/briefs', {
    method: 'POST',
    body: { source_type: 'chat', conversation },
  });
}

export async function confirmBrief(
  apiFetch: ApiFetch,
  briefId: string,
  payload: ConfirmRequest,
): Promise<ConfirmResponse> {
  return apiFetch<ConfirmResponse>(`/briefs/${briefId}/confirm`, {
    method: 'POST',
    body: payload,
  });
}

export async function getBrief(
  apiFetch: ApiFetch,
  briefId: string,
): Promise<BriefDetailResponse> {
  return apiFetch<BriefDetailResponse>(`/briefs/${briefId}`);
}
