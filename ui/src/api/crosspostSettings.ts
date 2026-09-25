import type { ApiFetch } from '../auth/useApiFetch';
import type { CrosspostPlatform, CrosspostSettings, CrosspostSettingsUpdate } from './types';

// Whether each cross-post platform can publish, and the write path that fixes
// it when it can't. Shared by the Settings "Cross-posting" tab and the content
// page's cross-post panel, so both read the same answer from one cache key.

export const CROSSPOST_SETTINGS_KEY = ['settings', 'crosspost'] as const;

export async function getCrosspostSettings(apiFetch: ApiFetch): Promise<CrosspostSettings> {
  return apiFetch<CrosspostSettings>('/settings/crosspost');
}

export async function updateCrosspostSettings(
  apiFetch: ApiFetch,
  payload: CrosspostSettingsUpdate,
): Promise<CrosspostSettings> {
  return apiFetch<CrosspostSettings>('/settings/crosspost', { method: 'PUT', body: payload });
}

export const CROSSPOST_PLATFORM_LABELS: Record<CrosspostPlatform, string> = {
  dev: 'DEV',
  medium: 'Medium',
  hashnode: 'Hashnode',
};

// Where the Settings card for a platform lives. The content page links here
// with `from` set so the card can offer a way back to the post.
export function crosspostSetupPath(platform: CrosspostPlatform, from?: string): string {
  const query = new URLSearchParams({ tab: 'crosspost' });
  if (from) query.set('from', from);
  return `/settings?${query.toString()}#crosspost-${platform}`;
}

// Only same-app paths are honored as a "back to" target. The value arrives in
// a URL anyone can craft, so an absolute or protocol-relative one is dropped
// rather than rendered as a link off-site.
export function safeReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}
