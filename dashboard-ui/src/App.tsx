import type { ReactElement } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { buildCognitoLogoutUrl } from './auth/config';

const navLinkClass = ({ isActive }: { isActive: boolean }): string =>
  isActive ? 'nav-link nav-link-active' : 'nav-link';

export default function App(): ReactElement {
  const auth = useAuth();

  const handleSignOut = (): void => {
    // Clear local OIDC state first, then bounce through Cognito's /logout
    // so the Hosted UI session cookie also dies. Without the second step,
    // the next signinRedirect would silently re-auth the same user.
    void auth.removeUser().then(() => {
      window.location.assign(buildCognitoLogoutUrl());
    });
  };

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
        <div className="app-user">
          {auth.isAuthenticated && (
            <>
              <span className="app-user-label">{userLabel(auth.user?.profile)}</span>
              <button type="button" className="app-user-action" onClick={handleSignOut}>
                Sign out
              </button>
            </>
          )}
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

function userLabel(profile: { email?: string; 'cognito:username'?: string } | undefined): string {
  if (!profile) return '';
  return profile.email ?? profile['cognito:username'] ?? 'Signed in';
}
