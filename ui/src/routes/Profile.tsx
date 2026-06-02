import type { ReactElement } from 'react';
import ProfileTab from '../components/ProfileTab';

export default function Profile(): ReactElement {
  return (
    <section className="space-y-6 max-w-3xl">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">Profile</h1>
      </header>
      <ProfileTab />
    </section>
  );
}
