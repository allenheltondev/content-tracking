import type { ReactElement } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LoginForm } from '@readysetcloud/ui/auth';
import { useAuth } from '../auth/useAuth';
import AuthLogo from '../components/AuthLogo';

interface LocationState {
  from?: string;
}

export default function SignIn(): ReactElement {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? {}) as LocationState;
  const redirectTo = state.from ?? '/';

  if (isAuthenticated) {
    return <Navigate to={redirectTo} replace />;
  }

  return (
    <div className="min-h-screen flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <LoginForm
        logo={<AuthLogo />}
        onSuccess={() => navigate(redirectTo, { replace: true })}
        // An unconfirmed account routes to sign-up's confirm step with the
        // credentials prefilled, so confirming finishes the sign-in.
        onNeedsConfirmation={(email, password) =>
          navigate('/signup', {
            replace: true,
            state: { confirmEmail: email, confirmPassword: password },
          })
        }
        // A force-reset account routes to the reset step with the code
        // already sent and the email prefilled.
        onPasswordResetRequired={(email) =>
          navigate('/forgot-password', {
            replace: true,
            state: { email, startAtReset: true },
          })
        }
        forgotPasswordLink={
          <Link to="/forgot-password" className="btn-link">
            Forgot password?
          </Link>
        }
        signUpPrompt={
          <span className="text-muted-foreground">
            Don&apos;t have an account?{' '}
            <Link to="/signup" className="text-primary-600 hover:text-primary-700 font-medium">
              Sign up
            </Link>
          </span>
        }
      />
    </div>
  );
}
