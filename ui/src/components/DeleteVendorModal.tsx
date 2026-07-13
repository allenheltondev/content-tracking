import type { ReactElement } from 'react';
import Modal from './Modal';

interface Props {
  open: boolean;
  vendorName: string;
  busy: boolean;
  serverError: string | null;
  blockingCampaignCount: number | null;
  onConfirm: () => void;
  onClose: () => void;
}

// Two states wrapped in one modal:
//   - First open: confirm deletion. If the API later rejects with 409,
//     the parent passes back the campaign count and we show the
//     blocking explanation instead of letting the user retry.
//   - Blocking: shown when blockingCampaignCount > 0. Confirm button
//     hidden; only Close remains.
export default function DeleteVendorModal({
  open,
  vendorName,
  busy,
  serverError,
  blockingCampaignCount,
  onConfirm,
  onClose,
}: Props): ReactElement {
  const isBlocked = blockingCampaignCount !== null && blockingCampaignCount > 0;

  return (
    <Modal open={open} title="Delete vendor" onClose={() => (!busy ? onClose() : undefined)}>
      {isBlocked ? (
        <div className="space-y-3">
          <p className="text-sm text-foreground">
            <strong>{vendorName}</strong> can't be deleted while it has{' '}
            {blockingCampaignCount} linked campaign
            {blockingCampaignCount === 1 ? '' : 's'}. Reassign or delete those campaigns first.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-foreground">
            Permanently delete <strong>{vendorName}</strong>? This can't be undone.
          </p>
          {serverError && <p className="form-error">{serverError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-error" onClick={onConfirm} disabled={busy}>
              {busy ? 'Deleting...' : 'Delete vendor'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
