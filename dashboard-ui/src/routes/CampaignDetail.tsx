import type { ReactElement } from 'react';
import { useParams } from 'react-router-dom';

export default function CampaignDetail(): ReactElement {
  const { campaignId } = useParams<{ campaignId: string }>();
  return (
    <section className="placeholder">
      <h1>Campaign detail</h1>
      <p>Coming soon. See issue #6 for the campaign detail view.</p>
      <p className="placeholder-meta">Campaign id: {campaignId ?? 'unknown'}</p>
    </section>
  );
}
