import type { ReactElement } from 'react';

interface Props {
  className?: string;
  alt?: string;
}

// The dashboard renders light-mode-only right now, so we always serve
// the dark-inked SVG (legible on the light background). When in-app
// dark mode lands, swap this to a <picture> with prefers-color-scheme
// (or, better, gate on the app's theme class rather than the OS
// preference -- the OS-level swap is what made the white logo
// disappear on the light backdrop initially). The favicon in
// index.html keeps its OS-level swap because that one's painted by
// browser chrome, which does follow OS theme.
export default function Logo({ className, alt = 'Booked' }: Props): ReactElement {
  return <img src="/booked-logo-light.svg" alt={alt} className={className} />;
}
