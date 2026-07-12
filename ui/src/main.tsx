import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { ToastProvider } from '@readysetcloud/ui';
// Shared design system: tokens, component classes, and brand fonts. Import
// before app styles so index.css can layer app-specific overrides on top.
import '@readysetcloud/ui/styles.css';
import '@readysetcloud/ui/fonts.css';
import { router } from './router';
import { AuthProvider } from './auth/AuthContext';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <AuthProvider>
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ToastProvider>
    </AuthProvider>
  </StrictMode>,
);
