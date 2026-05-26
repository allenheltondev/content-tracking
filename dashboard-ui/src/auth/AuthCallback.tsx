import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';

// Dedicated landing route for Cognito's post-sign-in redirect. The
// AuthProvider mounted in main.tsx automatically processes the
// `?code=...` query string on first render. Once we have a user (or an
// error), we bounce to /. Keeping this route separate from / lets
// Cognito's App Client config point at a stable, dedicated callback URL.
export default function AuthCallback(): ReactElement {
  const auth = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (auth.isAuthenticated || auth.error) {
      navigate('/', { replace: true });
    }
  }, [auth.isAuthenticated, auth.error, navigate]);

  if (auth.error) {
    return (
      <section className="auth-error">
        <h2>Sign-in failed</h2>
        <p>{auth.error.message}</p>
      </section>
    );
  }

  return <section className="auth-loading">Finishing sign-in...</section>;
}
