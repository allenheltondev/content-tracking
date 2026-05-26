import { createContext } from 'react';

export interface User {
  username: string;
  email: string;
}

export type SignInResult =
  | { kind: 'success' }
  | { kind: 'pending'; nextStep: string };

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  // Returns the current access token, refreshing if necessary. Throws
  // if the user isn't signed in.
  getAccessToken: () => Promise<string>;
}

export const AuthContext = createContext<AuthState | undefined>(undefined);
