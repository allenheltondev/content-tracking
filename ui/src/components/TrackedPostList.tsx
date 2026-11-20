import type { ReactElement } from 'react';
import { truncate } from '../lib/format';

interface TrackedPost {
  post_id: string;
  platform: string;
  url: string;
  notes: string | null;
  analytics: Record<string, number> | null;
  last_fetched: string | null;
}

interface Props {
  posts: TrackedPost[];
  onRemove: (post: TrackedPost) => void;
}

function formatMetrics(analytics: Record<string, number> | null): string {
  if (!analytics) return '—';
  const entries = Object.entries(analytics);
  if (entries.length === 0) return '—';
  return entries.map(([key, value]) => `${key}: ${value.toLocaleString()}`).join(' · ');
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

const COLS = 'sm:grid sm:grid-cols-[6rem_minmax(0,1.2fr)_minmax(0,1.5fr)_9rem_auto] sm:items-start sm:gap-4';

// One DOM tree for every width: stacked cards on phones, an aligned grid
// from the sm breakpoint up.
export default function TrackedPostList({ posts, onRemove }: Props): ReactElement {
  return (
    <div className="space-y-3 sm:space-y-0 sm:divide-y sm:divide-border">
      <div
        className={`hidden ${COLS} pb-2 text-xs font-medium uppercase text-muted-foreground`}
        aria-hidden="true"
      >
        <span>Platform</span>
        <span>Post</span>
        <span>Engagement</span>
        <span>Last fetched</span>
        <span />
      </div>
      <ul className="space-y-3 sm:space-y-0 sm:divide-y sm:divide-border">
        {posts.map((post) => (
          <li
            key={post.post_id}
            className={`card card-body space-y-2 sm:space-y-0 sm:rounded-none sm:border-0 sm:bg-transparent sm:shadow-none sm:px-0 sm:py-3 ${COLS}`}
          >
            <div className="flex items-center justify-between gap-2 sm:block">
              <span className="text-sm font-medium text-foreground capitalize">{post.platform}</span>
            </div>
            <div className="min-w-0">
              <a
                href={post.url}
                target="_blank"
                rel="noreferrer"
                className="block text-sm text-primary-600 hover:underline break-all"
              >
                {truncate(post.url, 50)}
              </a>
              {post.notes && (
                <span className="block text-xs text-muted-foreground break-words">{post.notes}</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground break-words">{formatMetrics(post.analytics)}</p>
            <p className="text-xs text-muted-foreground sm:text-sm">
              <span className="sm:hidden">Last fetched: </span>
              {formatTimestamp(post.last_fetched)}
            </p>
            <div className="sm:text-right">
              <button type="button" className="btn-link text-error-600" onClick={() => onRemove(post)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
