import type { ApiFetch } from '../auth/useApiFetch';
import type { MediaKitGenerateResponse, MediaKitListResponse } from './types';

// Generates a fresh media kit and returns the signed share link + stats.
export async function generateMediaKit(apiFetch: ApiFetch): Promise<MediaKitGenerateResponse> {
  return apiFetch<MediaKitGenerateResponse>('/media-kit', { method: 'POST' });
}

// Lists previously-generated media kits, newest first, each with a freshly
// re-signed link.
export async function listMediaKits(apiFetch: ApiFetch): Promise<MediaKitListResponse> {
  return apiFetch<MediaKitListResponse>('/media-kit');
}
