import type { ReactElement } from 'react';

export default function BriefNew(): ReactElement {
  return (
    <section className="placeholder">
      <h1>New brief</h1>
      <p>Coming soon. See issue #27 for the new-brief form.</p>
      <p className="placeholder-meta">
        This view will let you draft a campaign brief and submit it to the
        content-tracking API.
      </p>
    </section>
  );
}
