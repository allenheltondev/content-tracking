import type { ReactElement } from 'react';
import { Spinner } from '@readysetcloud/ui';
import AuthLogo from './AuthLogo';

// Branded splash shown once while the auth provider settles at startup.
// A single, centered loading state so page loads feel like a modern app
// rather than flashing a status message.
export default function LoadingScreen(): ReactElement {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="min-h-screen flex flex-col items-center justify-center gap-6 bg-background"
    >
      <AuthLogo />
      <Spinner className="h-8 w-8 text-primary-600" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
