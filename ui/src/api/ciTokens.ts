import type { ApiFetch } from '../auth/useApiFetch';
import type {
  CreateCiTokenRequest,
  CreateCiTokenResponse,
  ListCiTokensResponse,
} from './types';

export async function listCiTokens(
  apiFetch: ApiFetch,
): Promise<ListCiTokensResponse> {
  return apiFetch<ListCiTokensResponse>('/ci/tokens');
}

export async function createCiToken(
  apiFetch: ApiFetch,
  payload: CreateCiTokenRequest,
): Promise<CreateCiTokenResponse> {
  return apiFetch<CreateCiTokenResponse>('/ci/tokens', {
    method: 'POST',
    body: payload,
  });
}

export async function revokeCiToken(
  apiFetch: ApiFetch,
  jti: string,
): Promise<void> {
  await apiFetch(`/ci/tokens/${encodeURIComponent(jti)}`, {
    method: 'DELETE',
  });
}
