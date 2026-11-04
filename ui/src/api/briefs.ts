import { ApiError, type ApiFetch } from '../auth/useApiFetch';
import type { BriefResponse, Campaign, ChatEntry, StagedBriefUpload, UploadUrlResponse } from './types';

export type BriefFormat = 'pdf' | 'docx';

const CONTENT_TYPES: Record<BriefFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const MAX_BRIEF_BYTES = 10 * 1024 * 1024;

export const BRIEF_FILE_ACCEPT = `.pdf,.docx,${CONTENT_TYPES.pdf},${CONTENT_TYPES.docx}`;
export const BRIEF_FILE_HINT = 'PDF or Word (.docx). 10 MB max.';

// Goes by extension first: browsers often report no type for .docx.
export function briefFormat(file: File): BriefFormat | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === CONTENT_TYPES.pdf) return 'pdf';
  if (name.endsWith('.docx') || file.type === CONTENT_TYPES.docx) return 'docx';
  return null;
}

export function briefFileError(file: File): string | null {
  if (!briefFormat(file)) return 'Only PDF and Word (.docx) files are accepted.';
  if (file.size > MAX_BRIEF_BYTES) {
    return `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB.`;
  }
  return null;
}

export function briefErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 502) {
      return `The model couldn't parse the brief. Try again or simplify the input. (${err.message})`;
    }
    if (err.status === 413) {
      return 'The brief is too large for the API.';
    }
    if (err.status === 0) {
      return 'Network error. Check your connection and retry.';
    }
    return err.message;
  }
  return (err as Error).message;
}

export async function requestBriefUploadUrl(
  apiFetch: ApiFetch,
  campaignId: string,
  format: BriefFormat,
): Promise<UploadUrlResponse> {
  return apiFetch<UploadUrlResponse>(`/campaigns/${campaignId}/brief/upload-url`, {
    method: 'POST',
    body: { content_type: CONTENT_TYPES[format] },
  });
}

// Uploads a file directly to S3 via the presigned URL. This bypasses API
// Gateway's 6MB payload cap and avoids touching the backend Lambda for raw
// bytes. The content type must match the one the URL was signed with.
export async function uploadBriefFile(uploadUrl: string, file: File, format: BriefFormat): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': CONTENT_TYPES[format] },
    body: file,
  });
  if (!response.ok) {
    throw new ApiError(response.status, `File upload failed with HTTP ${response.status}`, null);
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

export async function submitFileBrief(
  apiFetch: ApiFetch,
  campaignId: string,
  format: BriefFormat,
): Promise<BriefResponse> {
  return apiFetch<BriefResponse>(`/campaigns/${campaignId}/brief`, {
    method: 'POST',
    body: { source_type: format },
  });
}

// --- Starting a campaign from a brief ----------------------------------------

export async function requestStagedBriefUpload(apiFetch: ApiFetch, format: BriefFormat): Promise<StagedBriefUpload> {
  return apiFetch<StagedBriefUpload>('/campaigns/from-brief/upload-url', {
    method: 'POST',
    body: { content_type: CONTENT_TYPES[format] },
  });
}

// Reads a staged brief and creates the campaign. Nothing is created if the file
// can't be read.
export async function createCampaignFromBrief(
  apiFetch: ApiFetch,
  params: { uploadId: string; format: BriefFormat; fileName: string },
): Promise<Campaign> {
  return apiFetch<Campaign>('/campaigns/from-brief', {
    method: 'POST',
    body: { upload_id: params.uploadId, source_type: params.format, file_name: params.fileName },
  });
}
