import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  claims,
  getFreshIdToken,
  onAuthChange,
  readSession,
  signOut as coreSignOut,
  type IdClaims,
} from '@readysetcloud/ui/auth';
import { AuthContext, type AuthState, type User } from './authContextValue';
import LoadingScreen from '../components/LoadingScreen';
import './config'; // side-effect: configureAuth runs on import

// Map the decoded id-token claims onto the app's User shape. `sub` is the
// stable Cognito identifier; email/name come straight from the claims the
// shared pool mints.
function userFromClaims(c: IdClaims): User {
  return {
    username: (c.sub as string) ?? c.email ?? '',
    email: c.email ?? '',
    firstName: c.given_name ?? '',
    lastName: c.family_name ?? '',
  };
}

function readUser(): User | null {
  return readSession() !== null ? userFromClaims(claims()) : null;
}

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [user, setUser] = useState<User | null>(readUser);
  // The session lives in localStorage, so the initial read above is
  // synchronous — there's no async probe to wait on. isLoading exists only
  // to satisfy the interface and stays false.
  const [isLoading] = useState(false);

  // Keep the provider in sync with sign-in/out — including changes made in
  // another tab or by the shared parent-domain cookie bridge.
  useEffect(() => {
    return onAuthChange(() => setUser(readUser()));
  }, []);

  const signOut = useCallback(async () => {
    await coreSignOut();
    setUser(null);
  }, []);

  // API Gateway's Cognito authorizer validates `aud` against the app
  // client, and only the id token carries that claim — so we send the id
  // token. getFreshIdToken auto-refreshes near expiry.
  const getAccessToken = useCallback(async (): Promise<string> => {
    const token = await getFreshIdToken();
    if (!token) {
      throw new Error('No ID token; sign in first.');
    }
    return token;
  }, []);

  const value: AuthState = {
    user,
    isAuthenticated: user !== null,
    isLoading,
    signOut,
    getAccessToken,
  };

  return (
    <AuthContext.Provider value={value}>
      {isLoading ? <LoadingScreen /> : children}
    </AuthContext.Provider>
  );
}
