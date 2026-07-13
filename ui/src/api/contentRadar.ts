import type { ApiFetch } from '../auth/useApiFetch';
import type {
  ContentIdeas,
  ContentRadarPreferences,
  FeedAggregate,
  FeedSource,
  GenerateContentIdeasParams,
  UpdateRadarPreferencesParams,
} from './types';

// Content Radar client. The creator curates a set of RSS/Atom feed sources;
// the aggregate feed and the idea generator both read those sources live
// (nothing is stored), so the radar can't go stale. Generating angles calls
// Bedrock and is the expensive part, so it's an explicit POST — like
// /voice/compose, the result isn't persisted and regenerating is a fresh read.

// The creator's feed sources, with health.
export async function listFeedSources(apiFetch: ApiFetch): Promise<FeedSource[]> {
  const res = await apiFetch<{ feeds: FeedSource[] }>('/content-radar/feeds');
  return res.feeds;
}

// Adds a feed to the radar. `url` must be a public http(s) feed URL; `title`
// overrides the feed's own title in the aggregate.
export async function addFeedSource(
  apiFetch: ApiFetch,
  url: string,
  title?: string,
): Promise<FeedSource> {
  return apiFetch<FeedSource>('/content-radar/feeds', {
    method: 'POST',
    body: title && title.trim().length > 0 ? { url, title: title.trim() } : { url },
  });
}

// Renames (title) and/or mutes a source. A muted source is excluded from the
// aggregate feed and idea generation but kept in the list. Pass title: null to
// clear a custom title.
export async function updateFeedSource(
  apiFetch: ApiFetch,
  feedId: string,
  fields: { title?: string | null; muted?: boolean },
): Promise<FeedSource> {
  return apiFetch<FeedSource>(`/content-radar/feeds/${feedId}`, {
    method: 'PATCH',
    body: fields,
  });
}

export async function deleteFeedSource(apiFetch: ApiFetch, feedId: string): Promise<void> {
  await apiFetch<void>(`/content-radar/feeds/${feedId}`, { method: 'DELETE' });
}

// The live aggregated feed across all active sources, newest first. `limit`
// caps how many items come back (server clamps to 60).
export async function getAggregatedFeed(
  apiFetch: ApiFetch,
  limit?: number,
): Promise<FeedAggregate> {
  const qs = typeof limit === 'number' ? `?limit=${limit}` : '';
  return apiFetch<FeedAggregate>(`/content-radar/feed${qs}`);
}

// The creator's stated radar intent (topics to lean into / avoid, default
// platform + guidance, audience). Defaults to empty lists / nulls when unset.
export async function getRadarPreferences(apiFetch: ApiFetch): Promise<ContentRadarPreferences> {
  return apiFetch<ContentRadarPreferences>('/content-radar/preferences');
}

// Saves radar preferences (partial — only the keys you pass are written).
export async function saveRadarPreferences(
  apiFetch: ApiFetch,
  fields: UpdateRadarPreferencesParams,
): Promise<ContentRadarPreferences> {
  return apiFetch<ContentRadarPreferences>('/content-radar/preferences', {
    method: 'PUT',
    body: fields,
  });
}

// Reads the live feed and proposes content angles in the creator's voice.
// Everything is optional: platform pins the target format, guidance steers the
// agent, feed_ids restricts to specific sources, limit caps items read.
export async function generateContentIdeas(
  apiFetch: ApiFetch,
  params: GenerateContentIdeasParams = {},
): Promise<ContentIdeas> {
  return apiFetch<ContentIdeas>('/content-radar/ideas', {
    method: 'POST',
    body: params,
  });
}
