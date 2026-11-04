import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import Modal from './Modal';

interface Props {
  title: string;
  confirmLabel: string;
  busyLabel: string;
  // Closes the dialog on success. A rejection stays open and shows the message.
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children: ReactNode;
}

// Asks before an action that can't be taken back. Mount it only while open.
export default function ConfirmModal({
  title,
  confirmLabel,
  busyLabel,
  onConfirm,
  onClose,
  children,
}: Props): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const close = (): void => {
    if (!busy) onClose();
  };

  return (
    <Modal open size="sm" title={title} onClose={close}>
      <div className="space-y-4">
        <p className="text-sm text-foreground [overflow-wrap:anywhere]">{children}</p>
        {error && <p className="form-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-error" onClick={() => void confirm()} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
