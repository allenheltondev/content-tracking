import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import Logo from '../components/Logo';

type Step = 'request' | 'confirm';

export default function ForgotPassword(): ReactElement {
  const { isAuthenticated, isLoading, resetPassword, confirmResetPassword, signIn } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  if (isLoading) {
    return (
      <section className="min-h-screen flex items-center justify-center text-muted-foreground">
        Checking session...
      </section>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const handleRequest = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      await resetPassword(email.trim());
      setStep('confirm');
      setInfo(`We sent a 6-digit code to ${email.trim()}.`);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!/^\d{6}$/.test(code)) {
      setError('Confirmation code must be 6 digits.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(newPassword)) {
      setError('Password must contain an uppercase letter, a lowercase letter, and a number.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await confirmResetPassword(email.trim(), code, newPassword);
      try {
        await signIn(email.trim(), newPassword);
        navigate('/', { replace: true });
      } catch {
        navigate('/signin', { replace: true });
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
          {step === 'request'
            ? "Enter your email and we'll send you a reset code."
            : 'Enter the code from your email and pick a new password.'}
        </p>
      </div>

      {step === 'request' ? (
        <form
          onSubmit={(e) => void handleRequest(e)}
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

          {error && <p className="form-error">{error}</p>}

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Sending code...' : 'Send reset code'}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => void handleConfirm(e)}
          className="mt-8 sm:mx-auto sm:w-full sm:max-w-md card card-body space-y-4"
        >
          <label className="block">
            <span className="field-label">Confirmation code</span>
            <input
              type="text"
              inputMode="numeric"
              className="input text-center tracking-widest"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              disabled={busy}
              autoFocus
              maxLength={6}
              placeholder="000000"
              required
            />
          </label>

          <label className="block">
            <span className="field-label">New password</span>
            <input
              type="password"
              className="input"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={busy}
              required
            />
            <p className="field-hint mt-1">
              At least 8 characters with upper, lower, and a number.
            </p>
          </label>

          <label className="block">
            <span className="field-label">Confirm new password</span>
            <input
              type="password"
              className="input"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={busy}
              required
            />
          </label>

          {info && (
            <p className="rounded-md border border-primary-200 bg-primary-50 text-primary-700 text-sm px-3 py-2">
              {info}
            </p>
          )}
          {error && <p className="form-error">{error}</p>}

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Updating...' : 'Reset password'}
          </button>

          <button
            type="button"
            className="btn-link"
            onClick={() => {
              setStep('request');
              setCode('');
              setNewPassword('');
              setConfirmPassword('');
              setError(null);
              setInfo(null);
            }}
            disabled={busy}
          >
            Use a different email
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Remembered it?{' '}
        <Link to="/signin" className="text-primary-600 hover:text-primary-700 font-medium">
          Sign in
        </Link>
      </p>
    </section>
  );
}

function humanError(err: unknown): string {
  if (!err) return 'Something went wrong.';
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name: string }).name;
    if (name === 'UserNotFoundException') return 'No account with that email.';
    if (name === 'CodeMismatchException') return 'That code is not correct.';
    if (name === 'ExpiredCodeException') return 'That code has expired. Request a new one.';
    if (name === 'InvalidPasswordException') return 'Password does not meet the requirements.';
    if (name === 'LimitExceededException') return 'Too many attempts. Wait a minute and try again.';
    if (name === 'TooManyRequestsException') return 'Too many requests. Wait a minute and try again.';
  }
  return err instanceof Error ? err.message : String(err);
}
