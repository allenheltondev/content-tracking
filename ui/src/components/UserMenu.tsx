import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { User } from '../auth/authContextValue';

interface Props {
  user: User;
  onSignOut: () => void;
}

function initialsFor(user: User): string {
  const first = user.firstName?.trim()?.[0];
  const last = user.lastName?.trim()?.[0];
  if (first && last) return `${first}${last}`.toUpperCase();
  if (first) return first.toUpperCase();
  const email = user.email || user.username || '';
  const localPart = email.split('@')[0] ?? '';
  const segments = localPart.split(/[._-]+/).filter(Boolean);
  if (segments.length >= 2) {
    return `${segments[0][0]}${segments[1][0]}`.toUpperCase();
  }
  return (localPart.slice(0, 2) || '?').toUpperCase();
}

export default function UserMenu({ user, onSignOut }: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const initials = initialsFor(user);
  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ');

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent): void => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        className="flex items-center justify-center h-9 w-9 rounded-full bg-primary-600 text-white text-sm font-semibold hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 focus:ring-offset-surface"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={displayName ? `Account menu for ${displayName}` : 'Account menu'}
      >
        {initials}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-64 card overflow-hidden z-50"
        >
          <div className="px-4 py-3 border-b border-border">
            {displayName && (
              <div className="text-sm font-medium text-foreground truncate">{displayName}</div>
            )}
            <div className="text-xs text-muted-foreground truncate">{user.email || user.username}</div>
          </div>
          <Link
            to="/settings"
            role="menuitem"
            className="block px-4 py-2 text-sm text-foreground hover:bg-muted"
            onClick={() => setOpen(false)}
          >
            Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            className="w-full text-left px-4 py-2 text-sm text-foreground hover:bg-muted border-t border-border"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
