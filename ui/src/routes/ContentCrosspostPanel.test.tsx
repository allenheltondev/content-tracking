import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CrosspostSettings, ContentAnalyticsResponse } from '../api/types';

// ContentDetail's import graph reaches auth/config, which throws at load time
// without the Vite env. The panel under test never touches it.
vi.mock('../auth/config', () => ({
  env: { apiBaseUrl: 'https://api.test', awsRegion: 'us-east-1', userPoolClientId: 'test' },
}));
vi.mock('../api/crosspostSettings', async (orig) => ({
  ...(await orig<typeof import('../api/crosspostSettings')>()),
  getCrosspostSettings: vi.fn(),
}));
vi.mock('../api/content', async (orig) => ({
  ...(await orig<typeof import('../api/content')>()),
  getContentAnalytics: vi.fn(),
  crosspostContent: vi.fn(),
  addPublishVariant: vi.fn(),
}));

const { getCrosspostSettings } = await import('../api/crosspostSettings');
const { getContentAnalytics, crosspostContent, addPublishVariant } = await import('../api/content');
const { ContentCrosspostPanel } = await import('./ContentDetail');

const apiFetch = vi.fn() as never;

const SETTINGS: CrosspostSettings = {
  platforms: {
    dev: { ready: true, token_configured: true, missing: [], organization_id: null },
    medium: { ready: false, token_configured: true, missing: ['publication_id'], publication_id: null },
    hashnode: { ready: false, token_configured: false, missing: ['token', 'publication_id'], publication_id: null, blog_url: null },
  },
};

function analytics(variants: { platform: string; url?: string }[] = []): ContentAnalyticsResponse {
  return {
    content_id: 'C1',
    publish_variants: variants.map((v) => ({ platform: v.platform, url: v.url ?? null })),
    stats: [],
  } as unknown as ContentAnalyticsResponse;
}

function renderPanel(): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/content/C1']}>
        <ContentCrosspostPanel contentId="C1" apiFetch={apiFetch} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(ui);
  return ui;
}

const row = (platform: string) => screen.getByTestId(`crosspost-row-${platform}`);

beforeEach(() => {
  vi.clearAllMocks();
  (getCrosspostSettings as ReturnType<typeof vi.fn>).mockResolvedValue(SETTINGS);
  (getContentAnalytics as ReturnType<typeof vi.fn>).mockResolvedValue(analytics());
});

describe('ContentCrosspostPanel', () => {
  it('offers "Cross-post for me" only where the platform is set up', async () => {
    renderPanel();
    await waitFor(() => expect(within(row('dev')).getByRole('button', { name: /cross-post for me/i })).toBeEnabled());

    expect(within(row('medium')).queryByRole('button', { name: /cross-post for me/i })).not.toBeInTheDocument();
    expect(within(row('hashnode')).queryByRole('button', { name: /cross-post for me/i })).not.toBeInTheDocument();
  });

  // A token alone is not enough for Medium: the row has to say what is.
  it('names exactly what an unready platform is missing', async () => {
    renderPanel();
    expect(await within(row('medium')).findByText(/needs a publication id/i)).toBeInTheDocument();
    expect(within(row('hashnode')).getByText(/needs an access token and a publication id/i)).toBeInTheDocument();
  });

  it('links an unready platform to its own Settings card, with a way back', async () => {
    renderPanel();
    const setUp = await within(row('medium')).findByRole('link', { name: /set up/i });
    expect(setUp).toHaveAttribute('href', '/settings?tab=crosspost&from=%2Fcontent%2FC1#crosspost-medium');
  });

  // Manual needs no credentials, so it must be there even when nothing is set up.
  it('offers "Add link" on every platform that has no copy yet', async () => {
    renderPanel();
    await waitFor(() => expect(within(row('hashnode')).getByRole('button', { name: /add link/i })).toBeEnabled());
    expect(within(row('dev')).getByRole('button', { name: /add link/i })).toBeInTheDocument();
    expect(within(row('medium')).getByRole('button', { name: /add link/i })).toBeInTheDocument();
  });

  it('shows a posted copy as a link and offers nothing else for it', async () => {
    (getContentAnalytics as ReturnType<typeof vi.fn>).mockResolvedValue(
      analytics([{ platform: 'dev', url: 'https://dev.to/me/hi' }]),
    );
    renderPanel();

    const link = await within(row('dev')).findByRole('link', { name: /posted/i });
    expect(link).toHaveAttribute('href', 'https://dev.to/me/hi');
    expect(within(row('dev')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('cross-posts just that platform', async () => {
    (crosspostContent as ReturnType<typeof vi.fn>).mockResolvedValue({
      content_id: 'C1', results: [{ platform: 'dev', status: 'succeeded', url: 'https://dev.to/me/hi' }],
    });
    renderPanel();

    const btn = await within(row('dev')).findByRole('button', { name: /cross-post for me/i });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);

    await waitFor(() => expect(crosspostContent).toHaveBeenCalledWith(apiFetch, 'C1', ['dev']));
  });

  it('shows the platform error when a cross-post fails', async () => {
    (crosspostContent as ReturnType<typeof vi.fn>).mockResolvedValue({
      content_id: 'C1', results: [{ platform: 'dev', status: 'failed', error: 'Dev.to publish failed: 401' }],
    });
    renderPanel();

    const btn = await within(row('dev')).findByRole('button', { name: /cross-post for me/i });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);

    expect(await within(row('dev')).findByText(/dev\.to publish failed: 401/i)).toBeInTheDocument();
  });

  // The platform key must be the one the server's duplicate guard reads, or a
  // later "Cross-post for me" would post a second copy.
  it('records a hand-posted copy under the platform key', async () => {
    (addPublishVariant as ReturnType<typeof vi.fn>).mockResolvedValue({});
    renderPanel();

    const add = await within(row('hashnode')).findByRole('button', { name: /add link/i });
    await waitFor(() => expect(add).toBeEnabled());
    await userEvent.click(add);
    await userEvent.type(within(row('hashnode')).getByLabelText(/link to the hashnode copy/i), 'https://me.hashnode.dev/hi');
    await userEvent.click(within(row('hashnode')).getByRole('button', { name: /save link/i }));

    await waitFor(() =>
      expect(addPublishVariant).toHaveBeenCalledWith(apiFetch, 'C1', { platform: 'hashnode', url: 'https://me.hashnode.dev/hi' }),
    );
  });

  it('rejects a link that is not a full URL', async () => {
    renderPanel();

    const add = await within(row('medium')).findByRole('button', { name: /add link/i });
    await waitFor(() => expect(add).toBeEnabled());
    await userEvent.click(add);
    await userEvent.type(within(row('medium')).getByLabelText(/link to the medium copy/i), 'medium.com/@me/hi');
    await userEvent.click(within(row('medium')).getByRole('button', { name: /save link/i }));

    expect(await within(row('medium')).findByText(/starting with https/i)).toBeInTheDocument();
    expect(addPublishVariant).not.toHaveBeenCalled();
  });

  // If setup can't be read, don't lock the author out. The server reports
  // precisely what's missing if a platform really isn't set up.
  it('still offers auto cross-post when setup could not be checked', async () => {
    (getCrosspostSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));
    renderPanel();

    expect(await screen.findByText(/could not check which platforms are set up/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(row('medium')).getByRole('button', { name: /cross-post for me/i })).toBeEnabled(),
    );
  });
});
