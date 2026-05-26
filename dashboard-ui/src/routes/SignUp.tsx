import type { FormEvent, ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import Logo from '../components/Logo';

type Step = 'signup' | 'confirm';

export default function SignUp(): ReactElement {
  const { isAuthenticated, isLoading, signUp, confirmSignUp, resendSignUpCode, signIn } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('signup');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

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

  const validateSignUp = (): string | null => {
    if (!firstName.trim()) return 'First name is required.';
    if (!lastName.trim()) return 'Last name is required.';
    if (!email.trim()) return 'Email is required.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Enter a valid email address.';
    if (password.length < 8) return 'Password must be at least 8 characters.';
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
      return 'Password must contain an uppercase letter, a lowercase letter, and a number.';
    }
    if (password !== confirmPassword) return 'Passwords do not match.';
    return null;
  };

  const handleSignUp = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const validationError = validateSignUp();
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    try {
      const result = await signUp(email.trim(), password, firstName.trim(), lastName.trim());
      if (result.kind === 'success') {
        // No confirmation required; try to sign in straight through.
        try {
          await signIn(email.trim(), password);
          navigate('/', { replace: true });
        } catch {
          navigate('/signin', { replace: true });
        }
        return;
      }
      setStep('confirm');
      setInfo(`We sent a 6-digit code to ${email.trim()}.`);
    } catch (err) {
      setError(humanSignUpError(err));
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
    setBusy(true);
    try {
      await confirmSignUp(email.trim(), code);
      try {
        await signIn(email.trim(), password);
        navigate('/', { replace: true });
      } catch {
        navigate('/signin', { replace: true });
      }
    } catch (err) {
      setError(humanConfirmError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async (): Promise<void> => {
    if (resendCooldown > 0) return;
    setError(null);
    setInfo(null);
    try {
      await resendSignUpCode(email.trim());
      setInfo('A new code is on its way.');
      setResendCooldown(60);
    } catch (err) {
      setError(humanConfirmError(err));
    }
  };

  return (
    <section className="min-h-screen flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center space-y-3">
        <Logo className="h-14 w-auto mx-auto" />
        <h1 className="text-2xl font-semibold text-foreground">Booked</h1>
        <p className="text-muted-foreground text-sm">
          {step === 'signup' ? 'Create your account.' : 'Verify your email to finish.'}
        </p>
      </div>

      {step === 'signup' ? (
        <form
          onSubmit={(e) => void handleSignUp(e)}
          className="mt-8 sm:mx-auto sm:w-full sm:max-w-md card card-body space-y-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="field-label">First name</span>
              <input
                type="text"
                className="input"
                autoComplete="given-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={busy}
                autoFocus
                required
              />
            </label>
            <label className="block">
              <span className="field-label">Last name</span>
              <input
                type="text"
                className="input"
                autoComplete="family-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={busy}
                required
              />
            </label>
          </div>

          <label className="block">
            <span className="field-label">Email</span>
            <input
              type="email"
              className="input"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
            />
          </label>

          <label className="block">
            <span className="field-label">Password</span>
            <input
              type="password"
              className="input"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
            />
            <p className="field-hint mt-1">
              At least 8 characters with upper, lower, and a number.
            </p>
          </label>

          <label className="block">
            <span className="field-label">Confirm password</span>
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

          {error && <p className="form-error">{error}</p>}

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Creating account...' : 'Create account'}
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

          {info && (
            <p className="rounded-md border border-primary-200 bg-primary-50 text-primary-700 text-sm px-3 py-2">
              {info}
            </p>
          )}
          {error && <p className="form-error">{error}</p>}

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Verifying...' : 'Verify email'}
          </button>

          <div className="flex justify-between text-sm">
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setStep('signup');
                setCode('');
                setError(null);
                setInfo(null);
              }}
              disabled={busy}
            >
              Back
            </button>
            <button
              type="button"
              className="btn-link"
              onClick={() => void handleResend()}
              disabled={busy || resendCooldown > 0}
            >
              {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
            </button>
          </div>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link to="/signin" className="text-primary-600 hover:text-primary-700 font-medium">
          Sign in
        </Link>
      </p>
    </section>
  );
}

function humanSignUpError(err: unknown): string {
  if (!err) return 'Sign-up failed.';
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name: string }).name;
    if (name === 'UsernameExistsException') return 'An account with that email already exists.';
    if (name === 'InvalidPasswordException') return 'Password does not meet the requirements.';
    if (name === 'InvalidParameterException') return 'One of the fields is invalid. Check your email and try again.';
    if (name === 'TooManyRequestsException') return 'Too many attempts. Wait a minute and try again.';
  }
  return err instanceof Error ? err.message : String(err);
}

function humanConfirmError(err: unknown): string {
  if (!err) return 'Verification failed.';
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name: string }).name;
    if (name === 'CodeMismatchException') return 'That code is not correct.';
    if (name === 'ExpiredCodeException') return 'That code has expired. Request a new one.';
    if (name === 'NotAuthorizedException') return 'This account is already confirmed. Try signing in.';
    if (name === 'LimitExceededException') return 'Too many attempts. Wait a minute and try again.';
  }
  return err instanceof Error ? err.message : String(err);
}
