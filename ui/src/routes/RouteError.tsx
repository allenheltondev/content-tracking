import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom';

// Shown when a URL matches nothing. Sits inside the app shell, so the nav stays.
export function NotFound(): ReactElement {
  return (
    <section className="mx-auto max-w-md space-y-4 px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold text-foreground">Page not found</h1>
      <p className="text-muted-foreground">That page doesn't exist or has moved.</p>
      <Link to="/" className="btn btn-primary">
        Go to dashboard
      </Link>
    </section>
  );
}

// Catches anything a route throws while rendering. Mounted inside the app shell
// for normal pages, and at the root for crashes in the shell itself.
export default function RouteError(): ReactElement {
  const error = useRouteError();

  useEffect(() => {
    console.error(error);
  }, [error]);

  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;

  return (
    <section className="mx-auto max-w-md space-y-4 px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold text-foreground">Something went wrong</h1>
      <p className="text-muted-foreground">This page hit an error and couldn't load.</p>
      {error instanceof Error && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{error.message}</p>}
      <div className="flex justify-center gap-2">
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload page
        </button>
        {/* A full load, since the router state may be what broke. */}
        <a href="/" className="btn btn-secondary">
          Go to dashboard
        </a>
      </div>
    </section>
  );
}
