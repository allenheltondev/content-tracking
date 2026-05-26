import type { ReactElement, ReactNode } from 'react';
import { useEffect } from 'react';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export default function Modal({ open, title, onClose, children }: Props): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 pb-4 px-4 bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card max-w-2xl w-full overflow-hidden">
        <div className="card-header flex items-center justify-between">
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
        <div className="card-body">{children}</div>
      </div>
    </div>
  );
}
