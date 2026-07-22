import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  generateEngagementRecommendation,
  getEngagementRecommendation,
} from '../api/recommendations';
import { ApiError, type ApiFetch } from '../auth/useApiFetch';
import { formatTimestamp, truncate } from '../lib/format';
import type {
  ContentPost,
  EngagementRecommendation,
  EngagementRecommendationItem,
  RecommendationPriority,
} from '../api/types';

// "Boost engagement" panel for the Analytics tab. For each tracked content
// post (Medium / dev.to) it surfaces AI suggestions — generated on demand via
// the backend's Bedrock pipeline — for where else to cross-post or promote the
// piece. Generation is explicit (it costs a model call); a previously
// generated set is loaded automatically and can be regenerated.
interface Props {
  apiFetch: ApiFetch;
  campaignId: string;
  posts: ContentPost[];
}

export default function EngagementRecommendationsSection({
  apiFetch,
  campaignId,
  posts,
}: Props): ReactElement {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground">Boost engagement</h2>
        <p className="text-sm text-muted-foreground">
          Suggestions for where else to cross-post or promote each piece to extend its reach.
          Generated per post on demand.
        </p>
      </div>
      {posts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add a Medium or dev.to post on the Promotion tab to get suggestions for promoting it.
        </p>
      ) : (
        <div className="space-y-3">
          {posts.map((post) => (
            <PostRecommendations
              key={post.post_id}
              apiFetch={apiFetch}
              campaignId={campaignId}
              post={post}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PostRecommendations({
  apiFetch,
  campaignId,
  post,
}: {
  apiFetch: ApiFetch;
  campaignId: string;
  post: ContentPost;
}): ReactElement {
  const [data, setData] = useState<EngagementRecommendation | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [showGoal, setShowGoal] = useState(false);

  // Load any previously generated set on mount. A 404 (resolved to null by the
  // client) just means none has been generated yet.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getEngagementRecommendation(apiFetch, campaignId, post.post_id)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, campaignId, post.post_id]);

  const generate = useCallback(async (): Promise<void> => {
    setGenerating(true);
    setError(null);
    try {
      const res = await generateEngagementRecommendation(
        apiFetch,
        campaignId,
        post.post_id,
        goal,
      );
      setData(res);
      setShowGoal(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [apiFetch, campaignId, post.post_id, goal]);

  return (
    <div className="card card-body space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {post.platform}
          </div>
          <a
            href={post.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary-600 hover:underline break-all"
          >
            {truncate(post.url, 70)}
          </a>
        </div>
        <button
          type="button"
          className="btn btn-secondary py-1 px-2 text-sm shrink-0"
          onClick={() => void generate()}
          disabled={generating}
        >
          {generating ? 'Generating…' : data ? 'Regenerate' : 'Get suggestions'}
        </button>
      </div>

      {!data && !generating && (
        <div className="space-y-2">
          {showGoal ? (
            <input
              type="text"
              className="input py-1.5 text-sm"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Optional goal — e.g. developer signups, not vanity reach"
              maxLength={500}
              autoFocus
            />
          ) : (
            <button
              type="button"
              className="btn-link text-sm"
              onClick={() => setShowGoal(true)}
            >
              + Add a goal to steer the suggestions
            </button>
          )}
        </div>
      )}

      {generating && (
        <p className="text-sm text-muted-foreground">
          Thinking through where this would land best… this can take a few seconds.
        </p>
      )}

      {error && <p className="form-error">{error}</p>}

      {loading && !data && !error && (
        <p className="text-sm text-muted-foreground">Checking for saved suggestions…</p>
      )}

      {data && !generating && <RecommendationDetail data={data} />}
    </div>
  );
}

function RecommendationDetail({ data }: { data: EngagementRecommendation }): ReactElement {
  return (
    <div className="space-y-3">
      {data.summary && <p className="text-sm text-foreground">{data.summary}</p>}

      {data.recommendations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No suggestions returned.</p>
      ) : (
        <ul className="space-y-3">
          {data.recommendations.map((rec, i) => (
            <RecommendationCard key={`${rec.channel}-${i}`} rec={rec} />
          ))}
        </ul>
      )}

      {data.already_covered.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Already covered:</span>{' '}
          {data.already_covered.join(' · ')}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Generated {formatTimestamp(data.generated_at)}
      </p>
    </div>
  );
}

function RecommendationCard({ rec }: { rec: EngagementRecommendationItem }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(rec.suggested_message).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <li className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-foreground">{rec.channel}</span>
        <span className="status-pill bg-muted text-muted-foreground">
          {rec.action === 'cross_post' ? 'Cross-post' : 'Promote'}
        </span>
        <span className={`status-pill ${priorityClass(rec.priority)}`}>{rec.priority}</span>
      </div>
      <p className="text-sm text-muted-foreground">{rec.rationale}</p>
      <div className="rounded bg-muted p-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Suggested message
          </span>
          <button type="button" className="btn-link text-xs" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-sm text-foreground whitespace-pre-wrap">{rec.suggested_message}</p>
      </div>
    </li>
  );
}

function priorityClass(priority: RecommendationPriority): string {
  switch (priority) {
    case 'high':
      return 'bg-primary-100 text-primary-700';
    case 'medium':
      return 'bg-warning-100 text-warning-800';
    default:
      return 'bg-muted text-muted-foreground';
  }
}
