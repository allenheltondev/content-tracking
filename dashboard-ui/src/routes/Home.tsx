import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

const tiles: { to: string; title: string; description: string }[] = [
  { to: '/campaigns', title: 'Campaigns', description: 'Active and historical campaigns with link analytics.' },
  { to: '/vendors', title: 'Vendors', description: 'Vendor records, contacts, and payment terms.' },
  { to: '/revenue', title: 'Revenue', description: 'Year-over-year revenue trend and per-vendor breakdown.' },
  { to: '/briefs/new', title: 'New brief', description: 'Drop in a vendor brief and turn it into a campaign.' },
];

export default function Home(): ReactElement {
  return (
    <section className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold text-foreground">content-tracking</h1>
        <p className="text-muted-foreground max-w-2xl">
          Campaigns, vendors, and revenue for the newsletter and adjacent content channels.
        </p>
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {tiles.map((tile) => (
          <Link
            key={tile.to}
            to={tile.to}
            className="card card-body hover:border-primary-300 hover:shadow-medium transition-all"
          >
            <h2 className="text-base font-semibold text-foreground">{tile.title}</h2>
            <p className="text-sm text-muted-foreground mt-1">{tile.description}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
