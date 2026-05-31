import type { ApiFetch } from '../auth/useApiFetch';
import type {
  ProfileImageKind,
  ProfileImageUploadResponse,
  ProfileResponse,
  ProfileUpdateRequest,
} from './types';

export async function getProfile(apiFetch: ApiFetch): Promise<ProfileResponse> {
  return apiFetch<ProfileResponse>('/profile');
}

export async function updateProfile(
  apiFetch: ApiFetch,
  payload: ProfileUpdateRequest,
): Promise<ProfileResponse> {
  return apiFetch<ProfileResponse>('/profile', { method: 'PUT', body: payload });
}

// Uploads an avatar or logo: mints a presigned PUT, uploads the file bytes
// straight to S3, and returns the stored key to persist via updateProfile.
export async function uploadProfileImage(
  apiFetch: ApiFetch,
  kind: ProfileImageKind,
  file: File,
): Promise<string> {
  const presign = await apiFetch<ProfileImageUploadResponse>('/profile/images/upload-url', {
    method: 'POST',
    body: { kind, content_type: file.type },
  });

  const res = await fetch(presign.url, {
    method: 'PUT',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!res.ok) {
    throw new Error(`Image upload failed (${res.status})`);
  }
  return presign.key;
}
