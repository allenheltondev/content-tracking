import type { ReactElement } from 'react';
import { useTheme } from '../theme/useTheme';

interface Props {
  className?: string;
  alt?: string;
}

// The logo swaps with the in-app theme: dark-inked SVG on light
// backgrounds, white-inked SVG on dark backgrounds. The favicon in
// index.html keeps its OS-level swap because that one's painted by
// browser chrome, which follows the OS preference, not our toggle.
export default function Logo({ className, alt = 'Booked' }: Props): ReactElement {
  const { theme } = useTheme();
  const src = theme === 'dark' ? '/booked-logo-dark.svg' : '/booked-logo-light.svg';
  return <img src={src} alt={alt} className={className} />;
}
