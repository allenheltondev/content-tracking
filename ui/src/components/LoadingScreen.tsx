import type { ReactElement } from 'react';
import Logo from './Logo';

// Branded splash shown once while the auth provider probes for an
// existing session at startup. Replaces the old per-route "Checking
// session..." text box with a single, centered loading state so page
// loads feel like a modern app rather than flashing a status message.
export default function LoadingScreen(): ReactElement {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="min-h-screen flex flex-col items-center justify-center gap-6 bg-background"
    >
      <Logo className="h-14 w-auto" />
      <div className="h-8 w-8 rounded-full border-2 border-border border-t-primary-600 animate-spin" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
