import type { ReactElement, ReactNode, SyntheticEvent } from 'react';
import { Modal as RscModal } from '@readysetcloud/ui';

type ModalSize = 'sm' | 'md' | 'lg';

interface Props {
  open: boolean;
  title: string;
  // Optional one-liner under the title, for dialogs that need framing.
  description?: string;
  // sm suits confirmations, md suits pickers, lg suits full forms.
  size?: ModalSize;
  onClose: () => void;
  children: ReactNode;
}

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-2xl',
};

// Thin wrapper over the shared package Modal (native <dialog>: focus trap,
// Esc/backdrop close, bottom-sheet on mobile). The package's .modal sets
// padding: 0 and leaves layout to the caller, so all spacing lives here:
// call sites pass bare content and never add their own gutters. The header is
// sticky so the title and close button stay put while a long form scrolls.
export default function Modal({
  open,
  title,
  description,
  size = 'lg',
  onClose,
  children,
}: Props): ReactElement {
  // Esc normally closes the <dialog> natively, which desyncs it from `open`
  // when onClose declines (a busy form). Routing it through onClose keeps React
  // in charge. Spread because the package's ModalProps doesn't declare it,
  // though it forwards the prop to the <dialog>.
  const escape = {
    onCancel: (e: SyntheticEvent): void => {
      e.preventDefault();
      onClose();
    },
  };

  return (
    <RscModal
      open={open}
      onClose={onClose}
      aria-label={title}
      className={`w-full ${SIZE_CLASSES[size]}`}
      {...escape}
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        <button
          type="button"
          className="-mr-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={onClose}
          aria-label="Close"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </div>
      <div className="px-6 py-5">{children}</div>
    </RscModal>
  );
}
