import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { ApiError, type ApiFetch } from '../auth/useApiFetch';
import { reviewDraft as runReviewDraft, saveDraft as saveDraftApi } from '../api/campaigns';
import type {
  Campaign,
  CampaignBrief,
  CampaignDraft,
  DraftIssueSeverity,
  DraftReview,
  DraftVerdict,
} from '../api/types';

interface Props {
  apiFetch: ApiFetch;
  campaign: Campaign;
  brief: CampaignBrief | null;
  draft: CampaignDraft | null;
  onDraftChange: (draft: CampaignDraft) => void;
}

// /preview is the iframeable read-only view; canonical /edit URLs send
// X-Frame-Options: DENY. Any doc shared "anyone with the link can view"
// renders here, which is the same sharing requirement the AI review needs.
function googleDocsPreviewUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/preview`;
}

export default function CampaignDraftTab({
  apiFetch,
  campaign,
  brief,
  draft,
  onDraftChange,
}: Props): ReactElement {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(draft?.url ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const showForm = editing || !draft;

  const handleSave = async (): Promise<void> => {
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      setSaveError('Paste a draft link.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const next = await saveDraftApi(apiFetch, campaign.campaign_id, { url: trimmed });
      onDraftChange(next);
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleReview = async (): Promise<void> => {
    setReviewing(true);
    setReviewError(null);
    try {
      const next = await runReviewDraft(apiFetch, campaign.campaign_id);
      onDraftChange(next);
    } catch (err) {
      setReviewError(formatReviewError(err));
    } finally {
      setReviewing(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <h2 className="text-lg font-semibold text-foreground">Draft</h2>
          <p className="text-sm text-muted-foreground">
            Paste a Google Doc link, then run the AI reviewer to see notes alongside the content.
          </p>
        </div>
        {draft && !editing && (
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              setUrl(draft.url);
              setSaveError(null);
              setEditing(true);
            }}
          >
            Replace draft
          </button>
        )}
      </div>

      {showForm && (
        <div className="card card-body space-y-3">
          <label className="block">
            <span className="field-label">Google Docs link</span>
            <input
              type="url"
              className="input"
              value={url}
              placeholder="https://docs.google.com/document/d/.../edit"
              onChange={(e) => setUrl(e.target.value)}
              disabled={saving}
            />
            <span className="field-hint">
              Share the doc as "Anyone with the link can view" so the embed and AI reviewer can read
              it.
            </span>
          </label>
          {saveError && <p className="form-error">{saveError}</p>}
          <div className="flex items-center justify-end gap-3">
            {draft && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setSaveError(null);
                  setUrl(draft.url);
                }}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? 'Saving...' : draft ? 'Replace' : 'Save draft'}
            </button>
          </div>
        </div>
      )}

      {draft && !editing && (
        <DraftWorkspace
          draft={draft}
          brief={brief}
          reviewing={reviewing}
          reviewError={reviewError}
          onReview={() => void handleReview()}
        />
      )}
    </section>
  );
}

interface WorkspaceProps {
  draft: CampaignDraft;
  brief: CampaignBrief | null;
  reviewing: boolean;
  reviewError: string | null;
  onReview: () => void;
}

function DraftWorkspace({
  draft,
  brief,
  reviewing,
  reviewError,
  onReview,
}: WorkspaceProps): ReactElement {
  const previewUrl = useMemo(
    () => (draft.doc_id ? googleDocsPreviewUrl(draft.doc_id) : null),
    [draft.doc_id],
  );

  const canReview = Boolean(draft.doc_id && brief);
  const reviewBlockedReason = !draft.doc_id
    ? 'AI review currently supports Google Docs links only.'
    : !brief
      ? 'Attach a brief to this campaign before reviewing its draft.'
      : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="card overflow-hidden">
        <div className="card-header flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">Draft preview</h3>
          <a href={draft.url} target="_blank" rel="noreferrer" className="btn-link">
            Open in Google Docs
          </a>
        </div>
        {previewUrl ? (
          <iframe
            title="Draft preview"
            src={previewUrl}
            className="w-full block border-0 bg-surface"
            style={{ height: 700 }}
          />
        ) : (
          <div className="card-body text-sm text-muted-foreground">
            This link isn't a Google Doc, so it can't be embedded.{' '}
            <a href={draft.url} target="_blank" rel="noreferrer" className="text-primary-600 hover:underline">
              Open it directly
            </a>
            .
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="card card-body space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">AI review</h3>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!canReview || reviewing}
              onClick={onReview}
            >
              {reviewing ? 'Reviewing...' : draft.review ? 'Re-run review' : 'Run AI review'}
            </button>
          </div>
          {reviewBlockedReason && (
            <p className="text-sm text-muted-foreground">{reviewBlockedReason}</p>
          )}
          {reviewError && <p className="form-error">{reviewError}</p>}
          {draft.reviewed_at && (
            <p className="field-hint">Reviewed {new Date(draft.reviewed_at).toLocaleString()}</p>
          )}
        </div>

        {draft.review ? (
          <ReviewPanel review={draft.review} />
        ) : (
          !reviewError && (
            <div className="card card-body text-sm text-muted-foreground">
              {canReview
                ? 'No review yet. Run one to see feedback against the brief.'
                : null}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function ReviewPanel({ review }: { review: DraftReview }): ReactElement {
  return (
    <div className="space-y-3">
      <div className="card card-body space-y-2">
        <div className="flex items-center gap-2">
          <VerdictPill verdict={review.verdict} />
        </div>
        <p className="text-sm text-foreground whitespace-pre-wrap">{review.summary}</p>
      </div>

      {review.brief_alignment && (
        <ReviewBlock title="Brief alignment">
          <p className="text-sm text-foreground whitespace-pre-wrap">{review.brief_alignment}</p>
        </ReviewBlock>
      )}

      {review.strengths && review.strengths.length > 0 && (
        <ReviewBlock title="Strengths">
          <ul className="list-disc pl-5 space-y-1 text-sm text-foreground">
            {review.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </ReviewBlock>
      )}

      {review.issues && review.issues.length > 0 && (
        <ReviewBlock title="Issues">
          <ul className="space-y-2">
            {review.issues.map((issue, i) => (
              <li key={i} className="border border-border rounded-lg p-3 space-y-1">
                <div className="flex items-center gap-2">
                  <SeverityPill severity={issue.severity} />
                  {issue.area && (
                    <span className="text-xs text-muted-foreground">{issue.area}</span>
                  )}
                </div>
                <p className="text-sm text-foreground whitespace-pre-wrap">{issue.detail}</p>
                {issue.suggestion && (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                    <span className="font-medium text-foreground">Suggestion:</span>{' '}
                    {issue.suggestion}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </ReviewBlock>
      )}

      {review.missing_requirements && review.missing_requirements.length > 0 && (
        <ReviewBlock title="Missing requirements">
          <ul className="list-disc pl-5 space-y-1 text-sm text-foreground">
            {review.missing_requirements.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </ReviewBlock>
      )}
    </div>
  );
}

function ReviewBlock({
  title,
  children,
}: {
  title: string;
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <section className="card card-body space-y-2">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      {children}
    </section>
  );
}

const VERDICT_LABELS: Record<DraftVerdict, string> = {
  ready: 'Ready',
  minor_revisions: 'Minor revisions',
  major_revisions: 'Major revisions',
};

const VERDICT_CLASSES: Record<DraftVerdict, string> = {
  ready: 'bg-success-100 text-success-800',
  minor_revisions: 'bg-warning-100 text-warning-800',
  major_revisions: 'bg-error-100 text-error-800',
};

function VerdictPill({ verdict }: { verdict: DraftVerdict }): ReactElement {
  const cls = VERDICT_CLASSES[verdict] ?? 'bg-secondary-100 text-secondary-700';
  const label = VERDICT_LABELS[verdict] ?? verdict;
  return (
    <span className={`status-pill ${cls}`}>{label}</span>
  );
}

const SEVERITY_CLASSES: Record<DraftIssueSeverity, string> = {
  high: 'bg-error-100 text-error-800',
  medium: 'bg-warning-100 text-warning-800',
  low: 'bg-secondary-100 text-secondary-700',
};

function SeverityPill({ severity }: { severity: DraftIssueSeverity }): ReactElement {
  const cls = SEVERITY_CLASSES[severity] ?? 'bg-secondary-100 text-secondary-700';
  return <span className={`status-pill ${cls}`}>{severity}</span>;
}

function formatReviewError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 502) {
      return `The model couldn't review the draft. Try again. (${err.message})`;
    }
    if (err.status === 0) {
      return 'Network error. Check your connection and retry.';
    }
    return err.message;
  }
  return (err as Error).message;
}
