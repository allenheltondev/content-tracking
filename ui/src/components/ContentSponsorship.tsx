import type { ReactElement } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '../auth/useApiFetch';
import { getCampaign } from '../api/campaigns';
import type { Campaign, Content } from '../api/types';
import { formatDateRange } from '../lib/format';
import LinkCampaignModal from './LinkCampaignModal';
import UnlinkCampaignModal from './UnlinkCampaignModal';

interface Props {
  content: Content;
  onChanged: (content: Content) => void;
}

// The campaign that sponsors this piece, a 1:1 optional link. Names the
// campaign when linked, and opens the picker when not.
export default function ContentSponsorship({ content, onChanged }: Props): ReactElement {
  const [linking, setLinking] = useState(false);

  return (
    <>
      {content.campaign_id ? (
        <LinkedCampaign
          campaignId={content.campaign_id}
          contentId={content.content_id}
          onUnlinked={() => onChanged({ ...content, campaign_id: null })}
        />
      ) : (
        <div className="card card-body flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Sponsorship</h2>
            <p className="text-sm text-muted-foreground">No campaign linked.</p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLinking(true)}>
            Link campaign
          </button>
        </div>
      )}

      {linking && (
        <LinkCampaignModal
          contentId={content.content_id}
          onClose={() => setLinking(false)}
          onLinked={(campaignId, updated) => {
            setLinking(false);
            onChanged(updated ?? { ...content, campaign_id: campaignId });
          }}
        />
      )}
    </>
  );
}

function LinkedCampaign({
  campaignId, contentId, onUnlinked,
}: {
  campaignId: string;
  contentId: string;
  onUnlinked: () => void;
}): ReactElement {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  // Same key and fetcher as the campaign workspace below, so this is one request.
  const { data, error: loadError } = useQuery({
    queryKey: ['campaign', campaignId],
    queryFn: () => getCampaign(apiFetch, campaignId),
  });
  const campaign = data?.campaign ?? null;

  return (
    <div className="card card-body flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-xs font-medium text-muted-foreground">Sponsored by campaign</h2>
        {campaign ? (
          <CampaignSummary campaign={campaign} />
        ) : loadError ? (
          <p className="form-error mt-1">Could not load the campaign: {(loadError as Error).message}</p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">Loading…</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Link to={`/campaigns/${campaignId}`} className="btn btn-secondary btn-sm">View campaign</Link>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
          Unlink
        </button>
      </div>

      {confirming && (
        <UnlinkCampaignModal
          contentId={contentId}
          title="Unlink campaign"
          onClose={() => setConfirming(false)}
          onUnlinked={() => {
            void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId], exact: true });
            onUnlinked();
          }}
        >
          Unlink <strong>{campaign?.name ?? 'this campaign'}</strong> from this piece? The campaign and its data
          stay in place, and you can link it again later.
        </UnlinkCampaignModal>
      )}
    </div>
  );
}

function CampaignSummary({ campaign }: { campaign: Campaign }): ReactElement {
  const dates = formatDateRange(campaign.startDate, campaign.endDate);
  const detail = [campaign.sponsor, dates === '-' ? null : dates].filter(Boolean).join(' · ');
  return (
    <>
      <p className="mt-0.5 flex flex-wrap items-center gap-2">
        <Link to={`/campaigns/${campaign.campaign_id}`} className="truncate text-base font-semibold text-foreground hover:underline">
          {campaign.name}
        </Link>
        <span className={`status-pill status-${campaign.status}`}>{campaign.status}</span>
      </p>
      {detail && <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>}
    </>
  );
}
