import type { ApiFetch } from '../auth/useApiFetch';
import type {
  MediaKitGenerateResponse,
  MediaKitListResponse,
  MediaKitPublishState,
} from './types';

// Generates a fresh media kit and returns the signed share link + stats.
export async function generateMediaKit(apiFetch: ApiFetch): Promise<MediaKitGenerateResponse> {
  return apiFetch<MediaKitGenerateResponse>('/media-kit', { method: 'POST' });
}

// Lists previously-generated media kits, newest first, each with a freshly
// re-signed link.
export async function listMediaKits(apiFetch: ApiFetch): Promise<MediaKitListResponse> {
  return apiFetch<MediaKitListResponse>('/media-kit');
}

// Reads the public-kit publish state (slug, published flag, public URL).
export async function getPublishState(apiFetch: ApiFetch): Promise<MediaKitPublishState> {
  return apiFetch<MediaKitPublishState>('/media-kit/publish');
}

// Publishes the public teaser to the stable vanity URL.
export async function publishMediaKit(apiFetch: ApiFetch): Promise<MediaKitPublishState> {
  return apiFetch<MediaKitPublishState>('/media-kit/publish', { method: 'POST' });
}

// Takes the public teaser down.
export async function unpublishMediaKit(apiFetch: ApiFetch): Promise<void> {
  await apiFetch<void>('/media-kit/publish', { method: 'DELETE' });
}
