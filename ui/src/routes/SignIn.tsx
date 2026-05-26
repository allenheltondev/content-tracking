import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import Logo from '../components/Logo';

interface LocationState {
  from?: string;
}

export default function SignIn(): ReactElement {
  const { isAuthenticated, isLoading, signIn } = useAuth();
  const location = useLocation();
  const state = (location.state ?? {}) as LocationState;
  const redirectTo = state.from ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingStep, setPendingStep] = useState<string | null>(null);

  if (isLoading) {
    return (
      <section className="min-h-screen flex items-center justify-center text-muted-foreground">
        Checking session...
      </section>
    );
  }

  if (isAuthenticated) {
    return <Navigate to={redirectTo} replace />;
  }

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setPendingStep(null);
    if (email.trim().length === 0 || password.length === 0) {
      setError('Email and password are required.');
      return;
    }
    setBusy(true);
    try {
      const result = await signIn(email.trim(), password);
      if (result.kind === 'pending') {
        setPendingStep(result.nextStep);
      }
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="min-h-screen flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center space-y-3">
        <Logo className="h-14 w-auto mx-auto" />
        <h1 className="text-2xl font-semibold text-foreground">Booked</h1>
        <p className="text-muted-foreground text-sm">
          Sign in to manage campaigns, vendors, and revenue.
        </p>
      </div>

      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="mt-8 sm:mx-auto sm:w-full sm:max-w-md card card-body space-y-4"
      >
        <label className="block">
          <span className="field-label">Email</span>
          <input
            type="email"
            className="input"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            autoFocus
            required
          />
        </label>

        <label className="block">
          <span className="field-label">Password</span>
          <input
            type="password"
            className="input"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
          />
        </label>

        {error && <p className="form-error">{error}</p>}

        {pendingStep && (
          <p className="rounded-md border border-warning-200 bg-warning-50 text-warning-900 text-sm px-3 py-2">
            Sign-in is incomplete (step: {pendingStep}). Finish setting up your account in
            newsletter-service, then try again here.
          </p>
        )}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>

        <div className="text-center">
          <Link to="/forgot-password" className="btn-link">
            Forgot password?
          </Link>
        </div>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{' '}
        <Link to="/signup" className="text-primary-600 hover:text-primary-700 font-medium">
          Sign up
        </Link>
      </p>
    </section>
  );
}

function humanError(err: unknown): string {
  if (!err) return 'Sign-in failed.';
  const message = err instanceof Error ? err.message : String(err);
  // Amplify wraps Cognito error codes; surface the readable name when
  // possible and fall back to the message.
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name: string }).name;
    if (name === 'NotAuthorizedException') return 'Email or password is incorrect.';
    if (name === 'UserNotFoundException') return 'No account with that email.';
    if (name === 'UserNotConfirmedException') return 'Your account needs email verification first.';
    if (name === 'TooManyRequestsException') return 'Too many attempts. Wait a minute and try again.';
  }
  return message;
}
