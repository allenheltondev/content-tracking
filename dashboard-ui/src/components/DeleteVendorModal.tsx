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
        <>
          <p>
            <strong>{vendorName}</strong> can't be deleted while it has{' '}
            {blockingCampaignCount} linked campaign
            {blockingCampaignCount === 1 ? '' : 's'}. Reassign or delete those campaigns first.
          </p>
          <div className="form-actions">
            <button type="button" className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Permanently delete <strong>{vendorName}</strong>? This can't be undone.
          </p>
          {serverError && <p className="form-error">{serverError}</p>}
          <div className="form-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={onConfirm} disabled={busy}>
              {busy ? 'Deleting...' : 'Delete vendor'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
