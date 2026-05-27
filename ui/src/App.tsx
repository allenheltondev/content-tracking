import type { ReactElement } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from './auth/useAuth';
import Logo from './components/Logo';
import UserMenu from './components/UserMenu';

const baseLink = 'px-3 py-1.5 rounded-md text-sm font-medium transition-colors';
const navLinkClass = ({ isActive }: { isActive: boolean }): string =>
  isActive
    ? `${baseLink} bg-primary-100 text-primary-700`
    : `${baseLink} text-muted-foreground hover:bg-muted hover:text-foreground`;

export default function App(): ReactElement {
  const { user, isAuthenticated, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = (): void => {
    void signOut().then(() => navigate('/signin', { replace: true }));
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-surface border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-6">
          <NavLink to="/" className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Logo className="h-6 w-auto" />
            Booked
          </NavLink>
          <nav className="flex items-center gap-1 flex-1" aria-label="Primary">
            <NavLink to="/campaigns" className={navLinkClass}>
              Campaigns
            </NavLink>
            <NavLink to="/vendors" className={navLinkClass}>
              Vendors
            </NavLink>
            <NavLink to="/revenue" className={navLinkClass}>
              Revenue
            </NavLink>
          </nav>
          {isAuthenticated && user && (
            <UserMenu user={user} onSignOut={handleSignOut} />
          )}
        </div>
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>
    </div>
  );
}
