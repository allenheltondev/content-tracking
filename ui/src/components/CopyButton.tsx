import type { ReactElement } from 'react';
import { useState } from 'react';

// Copy-to-clipboard with a brief confirmation. Used wherever the app produces
// text the user wants to paste elsewhere (composed drafts, answers).
export default function CopyButton({
  text,
  label = 'Copy',
  className = 'btn btn-secondary btn-sm',
}: {
  text: string;
  label?: string;
  className?: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (insecure context / denied permission);
      // fail silently rather than throwing in the click handler.
    }
  };

  return (
    <button type="button" className={className} onClick={() => void copy()} aria-live="polite">
      {copied ? 'Copied ✓' : label}
    </button>
  );
}
