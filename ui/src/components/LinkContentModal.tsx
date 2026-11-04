import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, useApiFetch } from '../auth/useApiFetch';
import { attachContentCampaign, listAllContent } from '../api/content';
import type { ContentSummary } from '../api/types';
import { formatDate, titleCase } from '../lib/format';
import Modal from './Modal';
import SearchPicker, { type PickerOption } from './SearchPicker';

interface Props {
  campaignId: string;
  onClose: () => void;
  onLinked: (contentId: string) => void;
}

function toOption(piece: ContentSummary): PickerOption {
  const published = piece.publish_date ? formatDate(piece.publish_date) : null;
  return {
    id: piece.content_id,
    label: piece.title,
    detail: [piece.type && titleCase(piece.type), piece.status && titleCase(piece.status), published]
      .filter(Boolean)
      .join(' · '),
  };
}

// Link a campaign to the piece of content it sponsors. The campaign-side twin of
// LinkCampaignModal, minus creating in place: a new piece needs a body and a
// slug, which don't fit a dialog. Mount it only while open.
export default function LinkContentModal({ campaignId, onClose, onLinked }: Props): ReactElement {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Search runs in the browser, so it needs every piece to be honest about "no
  // match".
  const { data, error: loadError, isPending } = useQuery({
    queryKey: ['content', 'picker'],
    queryFn: () => listAllContent(apiFetch),
  });

  // The API returns newest first, which is the order worth keeping here.
  const { options, unavailable } = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matching = (data?.content ?? []).filter((c) =>
      `${c.title} ${c.slug}`.toLowerCase().includes(term),
    );
    // A piece already pointing at this campaign stays pickable: it's a legacy
    // link with no back-pointer, and attaching repairs it.
    const isTaken = (c: ContentSummary): boolean => Boolean(c.campaign_id) && c.campaign_id !== campaignId;
    return {
      options: matching.filter((c) => !isTaken(c)).map(toOption),
      unavailable: matching.filter(isTaken).map(toOption),
    };
  }, [data, campaignId, search]);

  // showModal() focuses the close button. This effect runs after it (parents
  // after children) and moves focus to the field.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const link = async (): Promise<void> => {
    if (busy || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await attachContentCampaign(apiFetch, selectedId, campaignId);
      void queryClient.invalidateQueries({ queryKey: ['content'] });
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      onLinked(selectedId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('That piece is already linked to another campaign. Pick a different one.');
        setSelectedId(null);
        void queryClient.invalidateQueries({ queryKey: ['content', 'picker'] });
      } else {
        setError((err as Error).message);
      }
      setBusy(false);
    }
  };

  const close = (): void => {
    if (!busy) onClose();
  };

  return (
    <Modal open size="md" title="Link content" description="Choose the piece this campaign sponsors." onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void link();
        }}
        className="space-y-4"
      >
        <SearchPicker
          options={options}
          unavailable={unavailable}
          unavailableLabel="Already linked to another campaign"
          search={search}
          onSearchChange={(next) => {
            setSearch(next);
            setSelectedId(null);
          }}
          value={selectedId}
          onChange={setSelectedId}
          onConfirm={() => void link()}
          searchLabel="Search content"
          listLabel="Content"
          placeholder="Search by title or slug"
          loadingMessage="Loading content…"
          emptyMessage={search.trim() ? `Nothing matches “${search.trim()}”.` : 'You have no content yet.'}
          loading={isPending}
          disabled={busy}
          inputRef={inputRef}
        />
        {loadError && <p className="form-error">Could not load content: {(loadError as Error).message}</p>}
        {error && <p className="form-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !selectedId}>
            {busy ? 'Linking…' : 'Link content'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
