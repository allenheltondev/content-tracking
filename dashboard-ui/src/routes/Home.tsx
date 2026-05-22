import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

export default function Home(): ReactElement {
  return (
    <section>
      <h1>content-tracking dashboard</h1>
      <p>
        Track campaigns, vendors, and revenue for the newsletter and other
        content channels. The dashboard is a thin front end over the
        content-tracking API. Real data wiring lands in follow-up issues.
      </p>
      <h2>Sections</h2>
      <ul>
        <li>
          <Link to="/campaigns">Campaigns</Link>
        </li>
        <li>
          <Link to="/vendors">Vendors</Link>
        </li>
        <li>
          <Link to="/revenue">Revenue</Link>
        </li>
        <li>
          <Link to="/briefs/new">New brief</Link>
        </li>
      </ul>
    </section>
  );
}
