import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  confirmResetPassword as amplifyConfirmResetPassword,
  confirmSignUp as amplifyConfirmSignUp,
  fetchAuthSession,
  fetchUserAttributes,
  getCurrentUser,
  resendSignUpCode as amplifyResendSignUpCode,
  resetPassword as amplifyResetPassword,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  signUp as amplifySignUp,
  type AuthUser,
} from 'aws-amplify/auth';
import {
  AuthContext,
  type AuthState,
  type SignInResult,
  type SignUpResult,
  type User,
} from './authContextValue';
import LoadingScreen from '../components/LoadingScreen';
import './config'; // side-effect: Amplify.configure runs on import

async function loadUser(current: AuthUser): Promise<User> {
  const attrs = await fetchUserAttributes().catch(() => ({}) as Record<string, string | undefined>);
  return {
    username: current.username,
    email: attrs.email ?? current.signInDetails?.loginId ?? '',
    firstName: attrs.given_name ?? '',
    lastName: attrs.family_name ?? '',
  };
}

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Single source of truth: probe getCurrentUser at mount. If it
  // resolves we have a session; if it throws, we're signed out.
  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then(async (current) => {
        const next = await loadUser(current);
        if (!cancelled) setUser(next);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(
    async (email: string, password: string): Promise<SignInResult> => {
      const { isSignedIn, nextStep } = await amplifySignIn({
        username: email,
        password,
      });
      if (isSignedIn) {
        const current = await getCurrentUser();
        setUser(await loadUser(current));
        return { kind: 'success' };
      }
      return { kind: 'pending', nextStep: nextStep.signInStep };
    },
    [],
  );

  const signUp = useCallback(
    async (
      email: string,
      password: string,
      firstName: string,
      lastName: string,
    ): Promise<SignUpResult> => {
      const { isSignUpComplete } = await amplifySignUp({
        username: email,
        password,
        options: {
          userAttributes: {
            email,
            given_name: firstName,
            family_name: lastName,
          },
        },
      });
      return isSignUpComplete ? { kind: 'success' } : { kind: 'needs-confirmation' };
    },
    [],
  );

  const confirmSignUp = useCallback(async (email: string, code: string): Promise<void> => {
    await amplifyConfirmSignUp({ username: email, confirmationCode: code });
  }, []);

  const resendSignUpCode = useCallback(async (email: string): Promise<void> => {
    await amplifyResendSignUpCode({ username: email });
  }, []);

  const resetPassword = useCallback(async (email: string): Promise<void> => {
    await amplifyResetPassword({ username: email });
  }, []);

  const confirmResetPassword = useCallback(
    async (email: string, code: string, newPassword: string): Promise<void> => {
      await amplifyConfirmResetPassword({
        username: email,
        confirmationCode: code,
        newPassword,
      });
    },
    [],
  );

  const signOut = useCallback(async () => {
    await amplifySignOut();
    setUser(null);
  }, []);

  // API Gateway's Cognito authorizer validates `aud` against the app
  // client, and only the ID token carries that claim — access tokens
  // expose `client_id` instead and get rejected with 401. Same pattern
  // the newsletter-service dashboard hit; sending the ID token keeps
  // both APIs happy off the shared rsc-core pool.
  const getAccessToken = useCallback(async (): Promise<string> => {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    if (!token) {
      throw new Error('No ID token; sign in first.');
    }
    return token;
  }, []);

  const value: AuthState = {
    user,
    isAuthenticated: user !== null,
    isLoading,
    signIn,
    signUp,
    confirmSignUp,
    resendSignUpCode,
    resetPassword,
    confirmResetPassword,
    signOut,
    getAccessToken,
  };

  // Gate the whole app on the initial session probe so routes never
  // have to render their own "checking session" placeholder. By the
  // time children mount, auth state is settled.
  return (
    <AuthContext.Provider value={value}>
      {isLoading ? <LoadingScreen /> : children}
    </AuthContext.Provider>
  );
}
