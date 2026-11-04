import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router-dom';
import RouteError, { NotFound } from './RouteError';

function Crash(): never {
  throw new Error('Render blew up');
}

function renderAt(path: string): void {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <>
            <nav>App nav</nav>
            <Outlet />
          </>
        ),
        children: [
          {
            errorElement: <RouteError />,
            children: [
              { path: 'crash', element: <Crash /> },
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
}

describe('route errors', () => {
  it('shows not found inside the app shell for an unknown URL', () => {
    renderAt('/nope/at/all');

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText('App nav')).toBeInTheDocument();
  });

  it('keeps the app shell when a page crashes while rendering', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderAt('/crash');

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByText('Render blew up')).toBeInTheDocument();
    expect(screen.getByText('App nav')).toBeInTheDocument();
  });
});
