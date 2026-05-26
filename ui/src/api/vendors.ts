import type { ApiFetch } from '../auth/useApiFetch';
import type {
  Vendor,
  VendorCampaignsResponse,
  VendorListResponse,
  VendorPayload,
} from './types';

export async function listVendors(
  apiFetch: ApiFetch,
  options: { limit?: number } = {},
): Promise<VendorListResponse> {
  return apiFetch<VendorListResponse>('/vendors', {
    query: { limit: options.limit ?? 100 },
  });
}

export async function getVendor(apiFetch: ApiFetch, vendorId: string): Promise<Vendor> {
  return apiFetch<Vendor>(`/vendors/${vendorId}`);
}

export async function createVendor(
  apiFetch: ApiFetch,
  payload: VendorPayload,
): Promise<Vendor> {
  return apiFetch<Vendor>('/vendors', { method: 'POST', body: payload });
}

export async function updateVendor(
  apiFetch: ApiFetch,
  vendorId: string,
  payload: VendorPayload,
): Promise<Vendor> {
  return apiFetch<Vendor>(`/vendors/${vendorId}`, { method: 'PUT', body: payload });
}

export async function deleteVendor(apiFetch: ApiFetch, vendorId: string): Promise<void> {
  await apiFetch<void>(`/vendors/${vendorId}`, { method: 'DELETE' });
}

export async function listCampaignsForVendor(
  apiFetch: ApiFetch,
  vendorId: string,
): Promise<VendorCampaignsResponse> {
  return apiFetch<VendorCampaignsResponse>(`/vendors/${vendorId}/campaigns`);
}
