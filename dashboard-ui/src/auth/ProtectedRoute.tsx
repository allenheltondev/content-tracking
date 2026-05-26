import type { ReactElement, ReactNode } from 'react';
import { useEffect } from 'react';
import { useAuth } from 'react-oidc-context';

interface Props {
  children: ReactNode;
}

export default function ProtectedRoute({ children }: Props): ReactElement {
  const auth = useAuth();

  useEffect(() => {
    if (!auth.isLoading && !auth.isAuthenticated && !auth.activeNavigator && !auth.error) {
      auth.signinRedirect();
    }
  }, [auth]);

  if (auth.error) {
    return (
      <section className="auth-error">
        <h2>Sign-in failed</h2>
        <p>{auth.error.message}</p>
        <button type="button" onClick={() => auth.signinRedirect()}>
          Try again
        </button>
      </section>
    );
  }

  if (auth.isLoading || !auth.isAuthenticated) {
    return <section className="auth-loading">Signing you in...</section>;
  }

  return <>{children}</>;
}
