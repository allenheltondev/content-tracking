import type { ReactElement } from 'react';

// Logo for the pre-auth screens (sign in / up / reset). The auth cards sit
// on the `surface` token, so the ink has to flip with the theme. These
// screens render before the app shell mounts, so we swap on the OS scheme
// via <picture> rather than the in-app theme context.
export default function AuthLogo(): ReactElement {
  return (
    <picture>
      <source srcSet="/booked-logo-dark.svg" media="(prefers-color-scheme: dark)" />
      <img src="/booked-logo-light.svg" alt="Booked" className="h-12 w-auto mx-auto" />
    </picture>
  );
}
