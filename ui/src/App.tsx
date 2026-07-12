import type { ReactElement } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AppNav,
  readySetCloudServices,
  type AppNavItem,
  type AppNavLinkProps,
  type AppTheme,
} from '@readysetcloud/ui';
import { useAuth } from './auth/useAuth';
import { navIcons } from './components/NavIcons';

// Route the shared navbar's in-app links through react-router so
// navigation stays client-side (no full-page reload). External links in
// the app launcher fall back to a plain anchor automatically.
function RouterLink({ href, children, ...rest }: AppNavLinkProps): ReactElement {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

// AppNav persists nothing itself, so we seed the initial theme from the
// same key index.html reads for its anti-flash script, and write back on
// change. Values are the package's AppTheme ('light' | 'dark' | 'system').
const THEME_KEY = 'booked-theme';

function readStoredTheme(): AppTheme {
  const stored = typeof window !== 'undefined' ? window.localStorage.getItem(THEME_KEY) : null;
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

// Side-rail nav. `section` groups consecutive items under a heading; the
// app has enough destinations that a vertical rail reads better than a
// crowded top bar.
const NAV: ReadonlyArray<{ label: string; to: string; section: string }> = [
  { label: 'Campaigns', to: '/campaigns', section: 'Manage' },
  { label: 'Vendors', to: '/vendors', section: 'Manage' },
  { label: 'Revenue', to: '/revenue', section: 'Manage' },
  { label: 'Insights', to: '/insights', section: 'Manage' },
  { label: 'Blogs', to: '/blogs', section: 'Content' },
  { label: 'Content', to: '/content', section: 'Content' },
  { label: 'Compose', to: '/compose', section: 'Content' },
  { label: 'Voice', to: '/voice', section: 'Content' },
  { label: 'Media kit', to: '/media-kit', section: 'Content' },
  { label: 'Ask', to: '/ask', section: 'Assistant' },
  { label: 'Settings', to: '/settings', section: 'Account' },
];

export default function App(): ReactElement {
  const { user, isAuthenticated, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = (): void => {
    void signOut().then(() => navigate('/signin', { replace: true }));
  };

  const navItems: AppNavItem[] = NAV.map((item) => ({
    id: item.to,
    label: item.label,
    href: item.to,
    section: item.section,
    icon: navIcons[item.to],
    // Keep the section active for nested routes too (e.g. a campaign
    // detail page keeps "Campaigns" highlighted).
    active: location.pathname === item.to || location.pathname.startsWith(`${item.to}/`),
  }));

  const displayName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined
    : undefined;

  return (
    <div className="min-h-screen flex flex-col min-[641px]:flex-row">
      <AppNav
        appName="Booked"
        currentServiceId="booked"
        homeHref="/"
        layout="side"
        linkComponent={RouterLink}
        navItems={navItems}
        services={readySetCloudServices}
        authState={isAuthenticated ? 'authenticated' : 'anonymous'}
        user={user ? { name: displayName, email: user.email || user.username } : undefined}
        onProfileClick={() => navigate('/profile')}
        onSignOut={handleSignOut}
        defaultTheme={readStoredTheme()}
        onThemeChange={(theme) => window.localStorage.setItem(THEME_KEY, theme)}
        // Keep the rail pinned while the content column scrolls (desktop
        // only; below 641px the rail becomes a collapsible top bar).
        className="min-[641px]:sticky min-[641px]:top-0 min-[641px]:h-screen min-[641px]:self-start min-[641px]:overflow-y-auto"
      />
      <main className="flex-1 min-w-0 px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>
    </div>
  );
}
