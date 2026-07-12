import type { ReactElement } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { SignUpForm } from '@readysetcloud/ui/auth';
import { useAuth } from '../auth/useAuth';
import AuthLogo from '../components/AuthLogo';

interface LocationState {
  // Set by SignIn when an unconfirmed account tries to log in — prefills
  // the confirm step so the user can finish verifying and get signed in.
  confirmEmail?: string;
  confirmPassword?: string;
}

export default function SignUp(): ReactElement {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? {}) as LocationState;

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <SignUpForm
        logo={<AuthLogo />}
        onSuccess={() => navigate('/', { replace: true })}
        initialConfirmEmail={state.confirmEmail}
        initialConfirmPassword={state.confirmPassword}
        signInPrompt={
          <span className="text-muted-foreground">
            Already have an account?{' '}
            <Link to="/signin" className="text-primary-600 hover:text-primary-700 font-medium">
              Sign in
            </Link>
          </span>
        }
      />
    </div>
  );
}
