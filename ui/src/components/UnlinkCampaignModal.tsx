import type { ReactElement, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '../auth/useApiFetch';
import { detachContentCampaign } from '../api/content';
import ConfirmModal from './ConfirmModal';

interface Props {
  contentId: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
  onUnlinked: () => void;
}

// Confirms breaking the content-campaign link, from either side of it. Mount it
// only while open.
export default function UnlinkCampaignModal({ contentId, title, children, onClose, onUnlinked }: Props): ReactElement {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  const unlink = async (): Promise<void> => {
    await detachContentCampaign(apiFetch, contentId);
    void queryClient.invalidateQueries({ queryKey: ['content'] });
    void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    onUnlinked();
  };

  return (
    <ConfirmModal title={title} confirmLabel="Unlink" busyLabel="Unlinking…" onConfirm={unlink} onClose={onClose}>
      {children}
    </ConfirmModal>
  );
}
