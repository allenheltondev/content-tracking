import type { ApiFetch } from '../auth/useApiFetch';
import type {
  CreateExtensionPairingRequest,
  CreateExtensionPairingResponse,
  ListExtensionPairingsResponse,
} from './types';

export async function listExtensionPairings(
  apiFetch: ApiFetch,
): Promise<ListExtensionPairingsResponse> {
  return apiFetch<ListExtensionPairingsResponse>('/extensions/pairings');
}

export async function createExtensionPairing(
  apiFetch: ApiFetch,
  payload: CreateExtensionPairingRequest,
): Promise<CreateExtensionPairingResponse> {
  return apiFetch<CreateExtensionPairingResponse>('/extensions/pairings', {
    method: 'POST',
    body: payload,
  });
}

export async function revokeExtensionPairing(
  apiFetch: ApiFetch,
  jti: string,
): Promise<void> {
  await apiFetch(`/extensions/pairings/${encodeURIComponent(jti)}`, {
    method: 'DELETE',
  });
}
