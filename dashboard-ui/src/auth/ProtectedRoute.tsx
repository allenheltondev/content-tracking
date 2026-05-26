import type { ReactElement, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './useAuth';

interface Props {
  children: ReactNode;
}

export default function ProtectedRoute({ children }: Props): ReactElement {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <section className="max-w-md mx-auto mt-16 card card-body text-center text-muted-foreground">
        Checking session...
      </section>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}
