import type { ReactElement } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';

interface LocationState {
  fromBriefId?: string;
}

export default function CampaignDetail(): ReactElement {
  const { campaignId } = useParams<{ campaignId: string }>();
  const location = useLocation();
  const state = (location.state ?? {}) as LocationState;

  return (
    <section className="placeholder">
      <h1>
        Campaign detail
        {state.fromBriefId && <span className="from-brief-badge">From brief</span>}
      </h1>
      <p>Coming soon. See issue #6 for the campaign detail view.</p>
      <p className="placeholder-meta">Campaign id: {campaignId ?? 'unknown'}</p>
      {state.fromBriefId && (
        <p className="placeholder-meta">
          Created from{' '}
          <Link to={`/briefs/${state.fromBriefId}`}>brief {state.fromBriefId}</Link>.
        </p>
      )}
    </section>
  );
}
