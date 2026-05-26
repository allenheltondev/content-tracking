import type { ApiFetch } from '../auth/useApiFetch';
import type { VendorListResponse } from './types';

export async function listVendors(
  apiFetch: ApiFetch,
  options: { limit?: number } = {},
): Promise<VendorListResponse> {
  return apiFetch<VendorListResponse>('/vendors', {
    query: { limit: options.limit ?? 100 },
  });
}
