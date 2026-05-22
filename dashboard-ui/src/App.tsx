import type { ReactElement } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

const navLinkClass = ({ isActive }: { isActive: boolean }): string =>
  isActive ? 'nav-link nav-link-active' : 'nav-link';

export default function App(): ReactElement {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <NavLink to="/" className="brand-link">
            content-tracking
          </NavLink>
        </div>
        <nav className="app-nav" aria-label="Primary">
          <NavLink to="/campaigns" className={navLinkClass}>
            Campaigns
          </NavLink>
          <NavLink to="/vendors" className={navLinkClass}>
            Vendors
          </NavLink>
          <NavLink to="/revenue" className={navLinkClass}>
            Revenue
          </NavLink>
          <NavLink to="/briefs/new" className={navLinkClass}>
            New brief
          </NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
