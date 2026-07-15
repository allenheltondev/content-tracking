import type { ApiFetch } from '../auth/useApiFetch';
import type {
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  ListApiKeysResponse,
} from './types';

export async function listApiKeys(
  apiFetch: ApiFetch,
): Promise<ListApiKeysResponse> {
  return apiFetch<ListApiKeysResponse>('/api-keys');
}

export async function createApiKey(
  apiFetch: ApiFetch,
  payload: CreateApiKeyRequest,
): Promise<CreateApiKeyResponse> {
  return apiFetch<CreateApiKeyResponse>('/api-keys', {
    method: 'POST',
    body: payload,
  });
}

export async function revokeApiKey(
  apiFetch: ApiFetch,
  jti: string,
): Promise<void> {
  await apiFetch(`/api-keys/${encodeURIComponent(jti)}`, {
    method: 'DELETE',
  });
}
