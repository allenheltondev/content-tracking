import type { ApiFetch } from '../auth/useApiFetch';
import type { ProfileResponse, ProfileUpdateRequest } from './types';

export async function getProfile(apiFetch: ApiFetch): Promise<ProfileResponse> {
  return apiFetch<ProfileResponse>('/profile');
}

export async function updateProfile(
  apiFetch: ApiFetch,
  payload: ProfileUpdateRequest,
): Promise<ProfileResponse> {
  return apiFetch<ProfileResponse>('/profile', { method: 'PUT', body: payload });
}
