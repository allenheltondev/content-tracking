import type { ReactElement } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ForgotPasswordForm } from '@readysetcloud/ui/auth';
import { useAuth } from '../auth/useAuth';
import AuthLogo from '../components/AuthLogo';

interface LocationState {
  // Set by SignIn when Cognito forces a password reset — jumps straight to
  // the reset step (the code has already been sent) with the email filled.
  email?: string;
  startAtReset?: boolean;
}

export default function ForgotPassword(): ReactElement {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? {}) as LocationState;

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <ForgotPasswordForm
        logo={<AuthLogo />}
        onSuccess={() => navigate('/', { replace: true })}
        initialEmail={state.email}
        startAtReset={state.startAtReset}
        autoSignIn
        signInLink={
          <Link to="/signin" className="text-primary-600 hover:text-primary-700 font-medium">
            Sign in
          </Link>
        }
      />
    </div>
  );
}
