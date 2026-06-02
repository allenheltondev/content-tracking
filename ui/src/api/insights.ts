import type { ApiFetch } from '../auth/useApiFetch';
import type { InsightsResponse } from './types';

// Account-wide trends & insights over the creator's tracked content.
// Optional explicit date range; the API defaults to the trailing 90 days.
export async function getInsights(
  apiFetch: ApiFetch,
  options: { startDate?: string; endDate?: string } = {},
): Promise<InsightsResponse> {
  return apiFetch<InsightsResponse>('/insights', {
    query: { startDate: options.startDate, endDate: options.endDate },
  });
}
