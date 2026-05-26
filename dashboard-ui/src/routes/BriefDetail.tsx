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
      <section className="brief-detail">
        <h1>Brief not found</h1>
        <p className="form-error">{error}</p>
      </section>
    );
  }

  if (!brief) {
    return (
      <section className="brief-detail">
        <h1>Brief</h1>
        <p>Loading...</p>
      </section>
    );
  }

  return (
    <section className="brief-detail">
      <h1>Brief {brief.brief_id}</h1>

      <dl>
        <dt>Created</dt>
        <dd>{brief.created_at}</dd>
        <dt>Source</dt>
        <dd>{brief.source_type === 'pdf' ? 'PDF upload' : 'Chat transcript'}</dd>
        <dt>Original</dt>
        <dd>
          {brief.raw?.download_url ? (
            <a href={brief.raw.download_url} target="_blank" rel="noreferrer">
              Download the source
            </a>
          ) : (
            <span>Not available.</span>
          )}
        </dd>
        <dt>Campaign</dt>
        <dd>
          {brief.campaign_id ? (
            <Link to={`/campaigns/${brief.campaign_id}`}>{brief.campaign_id}</Link>
          ) : (
            <span>Not yet confirmed.</span>
          )}
        </dd>
      </dl>

      <h2>Summary</h2>
      <p className="summary-body">{brief.summary}</p>

      <WarningsBanner warnings={brief.warnings} />

      {brief.suggested_campaign?.deliverables &&
        brief.suggested_campaign.deliverables.length > 0 && (
          <>
            <h2>Deliverables (accepted)</h2>
            <ul>
              {brief.suggested_campaign.deliverables.map((d, i) => (
                <li key={i}>
                  <strong>
                    {d.platform} / {d.type}
                  </strong>
                  {d.count != null ? ` × ${d.count}` : ''}
                  {d.notes ? ` — ${d.notes}` : ''}
                </li>
              ))}
            </ul>
          </>
        )}
    </section>
  );
}
