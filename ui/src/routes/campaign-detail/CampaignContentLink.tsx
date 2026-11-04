import type { ReactElement } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '../../auth/useApiFetch';
import { getContent } from '../../api/content';
import type { Campaign } from '../../api/types';
import LinkContentModal from '../../components/LinkContentModal';
import UnlinkCampaignModal from '../../components/UnlinkCampaignModal';

interface Props {
  campaign: Campaign;
  onCampaignChange: (campaign: Campaign) => void;
}

// The piece of content this campaign sponsors, so the 1:1 link can be made,
// followed, and broken from the campaign side too.
export default function CampaignContentLink({ campaign, onCampaignChange }: Props): ReactElement {
  const [linking, setLinking] = useState(false);

  if (campaign.content_id) {
    return (
      <LinkedPiece
        contentId={campaign.content_id}
        campaignName={campaign.name}
        onUnlinked={() => onCampaignChange({ ...campaign, content_id: null })}
      />
    );
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        No content linked.{' '}
        <button type="button" className="btn-link" onClick={() => setLinking(true)}>
          Link content
        </button>
      </p>
      {linking && (
        <LinkContentModal
          campaignId={campaign.campaign_id}
          onClose={() => setLinking(false)}
          onLinked={(contentId) => {
            setLinking(false);
            onCampaignChange({ ...campaign, content_id: contentId });
          }}
        />
      )}
    </>
  );
}

function LinkedPiece({
  contentId, campaignName, onUnlinked,
}: {
  contentId: string;
  campaignName: string;
  onUnlinked: () => void;
}): ReactElement {
  const apiFetch = useApiFetch();
  const [confirming, setConfirming] = useState(false);
  const { data } = useQuery({
    queryKey: ['content', contentId],
    queryFn: () => getContent(apiFetch, contentId),
  });

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Sponsors{' '}
        <Link to={`/content/${contentId}`} className="btn-link">
          {data?.title ?? 'linked content'}
        </Link>
        {' · '}
        <button type="button" className="btn-link" onClick={() => setConfirming(true)}>
          Unlink
        </button>
      </p>
      {confirming && (
        <UnlinkCampaignModal
          contentId={contentId}
          title="Unlink content"
          onClose={() => setConfirming(false)}
          onUnlinked={onUnlinked}
        >
          Unlink <strong>{data?.title ?? 'this piece'}</strong> from {campaignName}? Both stay in place, and you
          can link them again later.
        </UnlinkCampaignModal>
      )}
    </>
  );
}
