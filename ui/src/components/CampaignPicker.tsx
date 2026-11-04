import type { ReactElement, Ref } from 'react';
import { useMemo } from 'react';
import type { Campaign, CampaignStatus } from '../api/types';
import { formatDateRange } from '../lib/format';
import SearchPicker, { type PickerOption } from './SearchPicker';

interface Props {
  campaigns: Campaign[];
  // The piece being linked. A campaign pointing at it is still pickable; one
  // pointing at any other piece is shown but can't be chosen (links are 1:1).
  contentId: string;
  search: string;
  onSearchChange: (search: string) => void;
  value: string | null;
  onChange: (campaignId: string) => void;
  // Enter on the option that's already selected.
  onConfirm: () => void;
  loading?: boolean;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

// Live work first, so the likely answer is at the top without searching.
const STATUS_ORDER: Record<CampaignStatus, number> = {
  active: 0,
  monitoring: 1,
  draft: 2,
  completed: 3,
};

function byRelevance(a: Campaign, b: Campaign): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.created_at.localeCompare(a.created_at);
}

function toOption(campaign: Campaign): PickerOption {
  const dates = formatDateRange(campaign.startDate, campaign.endDate);
  return {
    id: campaign.campaign_id,
    label: campaign.name,
    detail: [campaign.sponsor, dates === '-' ? null : dates].filter(Boolean).join(' · '),
    badge: <span className={`status-pill status-${campaign.status} shrink-0`}>{campaign.status}</span>,
  };
}

export default function CampaignPicker({ campaigns, contentId, search, ...rest }: Props): ReactElement {
  const { options, unavailable } = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matching = campaigns
      .filter((c) => `${c.name} ${c.sponsor ?? ''}`.toLowerCase().includes(term))
      .sort(byRelevance);
    const isTaken = (c: Campaign): boolean => Boolean(c.content_id) && c.content_id !== contentId;
    return {
      options: matching.filter((c) => !isTaken(c)).map(toOption),
      unavailable: matching.filter(isTaken).map(toOption),
    };
  }, [campaigns, contentId, search]);

  return (
    <SearchPicker
      {...rest}
      options={options}
      unavailable={unavailable}
      unavailableLabel="Already linked to other content"
      search={search}
      searchLabel="Search campaigns"
      listLabel="Campaigns"
      placeholder="Search by campaign or sponsor"
      loadingMessage="Loading campaigns…"
      emptyMessage={search.trim() ? `No campaigns match “${search.trim()}”.` : 'You have no campaigns yet.'}
    />
  );
}
