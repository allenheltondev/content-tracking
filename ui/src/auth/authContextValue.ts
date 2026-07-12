import { createContext } from 'react';

export interface User {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signOut: () => Promise<void>;
  // Returns a valid id token, refreshing if necessary. Throws if the
  // user isn't signed in. Used by useApiFetch for the Authorization header.
  getAccessToken: () => Promise<string>;
}

export const AuthContext = createContext<AuthState | undefined>(undefined);
