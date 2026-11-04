import type { FormEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, useApiFetch } from '../auth/useApiFetch';
import { listAllCampaigns } from '../api/campaigns';
import { attachContentCampaign, createContentSponsorship } from '../api/content';
import type { Content } from '../api/types';
import CampaignPicker from './CampaignPicker';
import Modal from './Modal';

interface Props {
  contentId: string;
  onClose: () => void;
  // Reports the new campaign id, plus the updated piece when the API returned
  // one. The caller owns updating the content cache.
  onLinked: (campaignId: string, content?: Content) => void;
}

// Link a piece of content to a campaign: pick an existing one, or create one
// without leaving the dialog. Mount it only while open so each visit starts
// clean.
export default function LinkCampaignModal({ contentId, onClose, onLinked }: Props): ReactElement {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [view, setView] = useState<'pick' | 'create'>('pick');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Search runs in the browser, so it needs every campaign to be honest about
  // "no match". The shared prefix lets a campaign mutation invalidate this too.
  const { data, error: loadError, isPending } = useQuery({
    queryKey: ['campaigns', 'picker'],
    queryFn: () => listAllCampaigns(apiFetch),
  });
  const campaigns = data?.campaigns ?? [];

  // showModal() focuses the first control, which is the close button. This
  // effect runs after it (parents after children) and moves focus to the field.
  useEffect(() => {
    inputRef.current?.focus();
  }, [view]);

  const finish = (campaignId: string, content?: Content): void => {
    void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] });
    onLinked(campaignId, content);
  };

  const link = async (): Promise<void> => {
    if (busy || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      finish(selectedId, await attachContentCampaign(apiFetch, contentId, selectedId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('That campaign is already linked to other content. Pick a different one.');
        setSelectedId(null);
        void queryClient.invalidateQueries({ queryKey: ['campaigns', 'picker'] });
      } else {
        setError((err as Error).message);
      }
      setBusy(false);
    }
  };

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const campaign = await createContentSponsorship(apiFetch, contentId, { name: name.trim() });
      finish(campaign.campaign_id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const close = (): void => {
    if (!busy) onClose();
  };

  if (view === 'create') {
    return (
      <Modal open size="md" title="New campaign" description="It links to this piece as soon as it's created." onClose={close}>
        <form onSubmit={(e) => void create(e)} className="space-y-4">
          <label className="block">
            <span className="field-label">Campaign name</span>
            <input
              ref={inputRef}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Q3 sponsorship"
              disabled={busy}
            />
          </label>
          <p className="text-sm text-muted-foreground">
            Add the sponsor, dates, and payout from the campaign once it exists.
          </p>
          {error && <p className="form-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                setError(null);
                setView('pick');
              }}
            >
              Back
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create and link'}
            </button>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal open size="md" title="Link a campaign" description="Choose the campaign that sponsors this piece." onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void link();
        }}
        className="space-y-4"
      >
        <CampaignPicker
          campaigns={campaigns}
          contentId={contentId}
          search={search}
          onSearchChange={(next) => {
            setSearch(next);
            setSelectedId(null);
          }}
          value={selectedId}
          onChange={setSelectedId}
          onConfirm={() => void link()}
          loading={isPending}
          disabled={busy}
          inputRef={inputRef}
        />
        {loadError && <p className="form-error">Could not load campaigns: {(loadError as Error).message}</p>}
        {error && <p className="form-error">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              setName(search.trim());
              setError(null);
              setView('create');
            }}
          >
            Create new campaign
          </button>
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !selectedId}>
              {busy ? 'Linking…' : 'Link campaign'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
