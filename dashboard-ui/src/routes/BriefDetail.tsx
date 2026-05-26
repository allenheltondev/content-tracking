import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import { getBrief } from '../api/briefs';
import type { BriefDetailResponse } from '../api/types';
import WarningsBanner from '../components/WarningsBanner';

export default function BriefDetail(): ReactElement {
  const { briefId } = useParams<{ briefId: string }>();
  const apiFetch = useApiFetch();
  const [brief, setBrief] = useState<BriefDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!briefId) return;
    let cancelled = false;
    getBrief(apiFetch, briefId)
      .then((res) => {
        if (!cancelled) setBrief(res);
      })
      .catch((err: ApiError | Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, briefId]);

  if (error) {
    return (
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">Brief not found</h1>
        <p className="form-error">{error}</p>
      </section>
    );
  }

  if (!brief) {
    return (
      <section>
        <h1 className="text-2xl font-semibold">Brief</h1>
        <p className="text-muted-foreground">Loading...</p>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold text-foreground">Brief {brief.brief_id}</h1>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Created</dt>
          <dd className="text-sm text-foreground mt-0.5">{brief.created_at}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Source</dt>
          <dd className="text-sm text-foreground mt-0.5">
            {brief.source_type === 'pdf' ? 'PDF upload' : 'Chat transcript'}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Original</dt>
          <dd className="text-sm mt-0.5">
            {brief.raw?.download_url ? (
              <a
                href={brief.raw.download_url}
                target="_blank"
                rel="noreferrer"
                className="text-primary-600 hover:underline"
              >
                Download the source
              </a>
            ) : (
              <span className="text-muted-foreground">Not available.</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Campaign</dt>
          <dd className="text-sm mt-0.5">
            {brief.campaign_id ? (
              <Link to={`/campaigns/${brief.campaign_id}`} className="text-primary-600 hover:underline">
                {brief.campaign_id}
              </Link>
            ) : (
              <span className="text-muted-foreground">Not yet confirmed.</span>
            )}
          </dd>
        </div>
      </dl>

      <section className="card card-body space-y-2">
        <h2 className="text-sm font-semibold text-foreground">Summary</h2>
        <p className="text-sm text-foreground whitespace-pre-wrap">{brief.summary}</p>
      </section>

      <WarningsBanner warnings={brief.warnings} />

      {brief.suggested_campaign?.deliverables &&
        brief.suggested_campaign.deliverables.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">Deliverables (accepted)</h2>
            <ul className="space-y-1">
              {brief.suggested_campaign.deliverables.map((d, i) => (
                <li key={i} className="text-sm">
                  <strong className="text-foreground">
                    {d.platform} / {d.type}
                  </strong>
                  {d.count != null && (
                    <span className="text-muted-foreground"> × {d.count}</span>
                  )}
                  {d.notes && (
                    <span className="text-muted-foreground"> — {d.notes}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
    </section>
  );
}
