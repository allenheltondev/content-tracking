import type { ReactElement, ReactNode } from 'react';
import { Modal as RscModal } from '@readysetcloud/ui';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

// Thin wrapper over the shared package Modal (native <dialog>: focus trap,
// Esc/backdrop close, bottom-sheet on mobile). Keeps the app's `title`
// convention by rendering a header, so existing call sites don't change.
export default function Modal({ open, title, onClose, children }: Props): ReactElement {
  return (
    <RscModal open={open} onClose={onClose} aria-label={title} className="w-full max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-2xl leading-none px-1"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      {children}
    </RscModal>
  );
}
