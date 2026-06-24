import type { ReactElement } from 'react';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from './auth/useAuth';
import Logo from './components/Logo';
import UserMenu from './components/UserMenu';
import { useTheme } from './theme/useTheme';

const baseLink = 'rounded-md text-sm font-medium transition-colors';

// The nav links render in two places — the horizontal desktop bar and the
// collapsed mobile sheet — so the active/idle styling is factored out and
// the layout (padding/block) is passed in per surface.
const linkClass =
  (extra: string) =>
  ({ isActive }: { isActive: boolean }): string =>
    isActive
      ? `${baseLink} ${extra} bg-primary-100 text-primary-700`
      : `${baseLink} ${extra} text-muted-foreground hover:bg-muted hover:text-foreground`;

const desktopLink = linkClass('px-3 py-1.5');
const mobileLink = linkClass('block px-3 py-2.5');

function NavItems({
  className,
  onNavigate,
}: {
  className: ReturnType<typeof linkClass>;
  onNavigate?: () => void;
}): ReactElement {
  return (
    <>
      <NavLink to="/campaigns" className={className} onClick={onNavigate}>
        Campaigns
      </NavLink>
      <NavLink to="/vendors" className={className} onClick={onNavigate}>
        Vendors
      </NavLink>
      <NavLink to="/revenue" className={className} onClick={onNavigate}>
        Revenue
      </NavLink>
      <NavLink to="/insights" className={className} onClick={onNavigate}>
        Insights
      </NavLink>
      <NavLink to="/blogs" className={className} onClick={onNavigate}>
        Blogs
      </NavLink>
      <NavLink to="/ask" className={className} onClick={onNavigate}>
        Ask
      </NavLink>
      <NavLink to="/compose" className={className} onClick={onNavigate}>
        Compose
      </NavLink>
      <NavLink to="/voice" className={className} onClick={onNavigate}>
        Voice
      </NavLink>
      <NavLink to="/media-kit" className={className} onClick={onNavigate}>
        Media kit
      </NavLink>
    </>
  );
}

export default function App(): ReactElement {
  const { user, isAuthenticated, signOut } = useAuth();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleSignOut = (): void => {
    void signOut().then(() => navigate('/signin', { replace: true }));
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-surface border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-4 sm:gap-6">
          <NavLink
            to="/"
            className="flex items-center gap-2 text-base font-semibold text-foreground shrink-0"
            onClick={() => setMenuOpen(false)}
          >
            <Logo className="h-6 w-auto" />
            Booked
          </NavLink>

          {/* Desktop nav — hidden on small screens in favour of the sheet. */}
          <nav className="hidden md:flex items-center gap-1 flex-1" aria-label="Primary">
            <NavItems className={desktopLink} />
          </nav>

          {/* Pushes the controls to the right on mobile, where the nav is hidden. */}
          <div className="flex-1 md:hidden" />

          <button
            type="button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            className="flex items-center justify-center h-9 w-9 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary-500 shrink-0"
          >
            <span aria-hidden>{theme === 'dark' ? '☀' : '☾'}</span>
          </button>
          {isAuthenticated && user && (
            <UserMenu user={user} onSignOut={handleSignOut} />
          )}

          {/* Hamburger — toggles the mobile nav sheet. */}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            className="md:hidden flex items-center justify-center h-9 w-9 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary-500 shrink-0"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {menuOpen ? (
                <>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </>
              ) : (
                <>
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </>
              )}
            </svg>
          </button>
        </div>

        {/* Mobile nav sheet — collapses the primary links behind the hamburger. */}
        {menuOpen && (
          <nav
            id="mobile-nav"
            className="md:hidden border-t border-border px-2 py-2 flex flex-col gap-1"
            aria-label="Primary"
          >
            <NavItems className={mobileLink} onNavigate={() => setMenuOpen(false)} />
          </nav>
        )}
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>
    </div>
  );
}
