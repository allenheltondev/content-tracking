import { createContext } from 'react';

export interface User {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
}

export type SignInResult =
  | { kind: 'success' }
  | { kind: 'pending'; nextStep: string };

export type SignUpResult =
  | { kind: 'success' }
  | { kind: 'needs-confirmation' };

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signUp: (
    email: string,
    password: string,
    firstName: string,
    lastName: string,
  ) => Promise<SignUpResult>;
  confirmSignUp: (email: string, code: string) => Promise<void>;
  resendSignUpCode: (email: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  confirmResetPassword: (
    email: string,
    code: string,
    newPassword: string,
  ) => Promise<void>;
  signOut: () => Promise<void>;
  // Returns the current access token, refreshing if necessary. Throws
  // if the user isn't signed in.
  getAccessToken: () => Promise<string>;
}

export const AuthContext = createContext<AuthState | undefined>(undefined);
