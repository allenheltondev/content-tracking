import type { ApiFetch } from '../auth/useApiFetch';
import type { RevenueResponse } from './types';

export async function getRevenue(
  apiFetch: ApiFetch,
  options: {
    year?: number;
    startDate?: string;
    endDate?: string;
    vendorId?: string;
    grouping?: 'year' | 'month' | 'vendor';
    paidOnly?: boolean;
  } = {},
): Promise<RevenueResponse> {
  return apiFetch<RevenueResponse>('/revenue', {
    query: {
      year: options.year,
      startDate: options.startDate,
      endDate: options.endDate,
      vendorId: options.vendorId,
      grouping: options.grouping,
      paidOnly: options.paidOnly !== undefined ? String(options.paidOnly) : undefined,
    },
  });
}
