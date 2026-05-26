import type { ReactElement } from 'react';

interface Props {
  className?: string;
  alt?: string;
}

// Renders the Booked mark with prefers-color-scheme branching. The
// light-fill SVG (dark ink) draws on light backgrounds; the dark-fill
// SVG (white ink) draws on dark backgrounds once dark mode lands. Both
// assets live in /public so they're cache-stable across deploys.
export default function Logo({ className, alt = 'Booked' }: Props): ReactElement {
  return (
    <picture>
      <source srcSet="/booked-logo-dark.svg" media="(prefers-color-scheme: dark)" />
      <img src="/booked-logo-light.svg" alt={alt} className={className} />
    </picture>
  );
}
