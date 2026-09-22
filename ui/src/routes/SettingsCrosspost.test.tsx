import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CrosspostSettings } from '../api/types';

vi.mock('../auth/config', () => ({
  env: { apiBaseUrl: 'https://api.test', awsRegion: 'us-east-1', userPoolClientId: 'test' },
}));
vi.mock('../auth/useApiFetch', () => {
  const apiFetch = async () => undefined;
  class ApiError extends Error {}
  return { useApiFetch: () => apiFetch, ApiError };
});
vi.mock('../api/crosspostSettings', async (orig) => ({
  ...(await orig<typeof import('../api/crosspostSettings')>()),
  getCrosspostSettings: vi.fn(),
  updateCrosspostSettings: vi.fn(),
}));

const { getCrosspostSettings, updateCrosspostSettings } = await import('../api/crosspostSettings');
const Settings = (await import('./Settings')).default;

const SETTINGS: CrosspostSettings = {
  platforms: {
    dev: { ready: true, token_configured: true, missing: [], organization_id: null },
    medium: { ready: false, token_configured: true, missing: ['publication_id'], publication_id: null },
    hashnode: { ready: false, token_configured: false, missing: ['token', 'publication_id'], publication_id: null, blog_url: null },
  },
};

function renderAt(url: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const card = async (platform: string) => {
  await screen.findByRole('heading', { name: platform === 'dev' ? 'DEV' : platform[0].toUpperCase() + platform.slice(1) });
  return document.getElementById(`crosspost-${platform}`) as HTMLElement;
};

beforeEach(() => {
  vi.clearAllMocks();
  (getCrosspostSettings as ReturnType<typeof vi.fn>).mockResolvedValue(SETTINGS);
  (updateCrosspostSettings as ReturnType<typeof vi.fn>).mockResolvedValue(SETTINGS);
});

describe('Settings > Cross-posting', () => {
  it('shows each platform with what it still needs', async () => {
    renderAt('/settings?tab=crosspost');

    expect(within(await card('dev')).getByText('Ready')).toBeInTheDocument();
    expect(within(await card('medium')).getByText(/needs publication id/i)).toBeInTheDocument();
    expect(within(await card('hashnode')).getByText(/needs personal access token and publication id/i)).toBeInTheDocument();
  });

  // Tokens are write-only. The server never sends one, and the form must not
  // hold one after a save either.
  it('never pre-fills a stored token', async () => {
    renderAt('/settings?tab=crosspost');
    const input = within(await card('dev')).getByLabelText(/api key/i) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
  });

  it('saves only what changed on that one platform', async () => {
    renderAt('/settings?tab=crosspost');
    const hn = await card('hashnode');

    await userEvent.type(within(hn).getByLabelText(/personal access token/i), 'hn-token');
    await userEvent.type(within(hn).getByLabelText(/publication id/i), 'pub-1');
    await userEvent.click(within(hn).getByRole('button', { name: /save hashnode/i }));

    await waitFor(() =>
      expect(updateCrosspostSettings).toHaveBeenCalledWith(expect.anything(), {
        platforms: { hashnode: { token: 'hn-token', publication_id: 'pub-1' } },
      }),
    );
  });

  it('clears the token field once it is stored', async () => {
    renderAt('/settings?tab=crosspost');
    const dev = await card('dev');
    const input = within(dev).getByLabelText(/api key/i) as HTMLInputElement;

    await userEvent.type(input, 'new-key');
    await userEvent.click(within(dev).getByRole('button', { name: /save dev/i }));

    await waitFor(() => expect(updateCrosspostSettings).toHaveBeenCalled());
    await waitFor(() => expect(input.value).toBe(''));
  });

  // An emptied id is a deliberate clear, sent as null.
  it('sends null for an id the author emptied', async () => {
    (getCrosspostSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      platforms: { ...SETTINGS.platforms, medium: { ...SETTINGS.platforms.medium, publication_id: 'old-pub' } },
    });
    renderAt('/settings?tab=crosspost');
    const medium = await card('medium');
    const idInput = within(medium).getByLabelText(/publication id/i) as HTMLInputElement;
    await waitFor(() => expect(idInput.value).toBe('old-pub'));

    await userEvent.clear(idInput);
    await userEvent.click(within(medium).getByRole('button', { name: /save medium/i }));

    await waitFor(() =>
      expect(updateCrosspostSettings).toHaveBeenCalledWith(expect.anything(), {
        platforms: { medium: { publication_id: null } },
      }),
    );
  });

  it('does not send a request when nothing was entered', async () => {
    renderAt('/settings?tab=crosspost');
    const hn = await card('hashnode');
    await userEvent.click(within(hn).getByRole('button', { name: /save hashnode/i }));

    expect(await within(hn).findByText(/paste your personal access token/i)).toBeInTheDocument();
    expect(updateCrosspostSettings).not.toHaveBeenCalled();
  });

  it('asks before disconnecting, then clears only the token', async () => {
    renderAt('/settings?tab=crosspost');
    const medium = await card('medium');

    await userEvent.click(within(medium).getByRole('button', { name: /^disconnect$/i }));
    expect(updateCrosspostSettings).not.toHaveBeenCalled();
    expect(within(medium).getByText(/remove the stored integration token/i)).toBeInTheDocument();

    await userEvent.click(within(medium).getByRole('button', { name: /^disconnect$/i }));
    await waitFor(() =>
      expect(updateCrosspostSettings).toHaveBeenCalledWith(expect.anything(), { platforms: { medium: { token: null } } }),
    );
  });

  it('offers disconnect only where a token is stored', async () => {
    renderAt('/settings?tab=crosspost');
    expect(within(await card('hashnode')).queryByRole('button', { name: /disconnect/i })).not.toBeInTheDocument();
  });

  // The content page sends the author here with `from`; after setting up they
  // need a way back to the post they were cross-posting.
  it('links back to the post it was sent from', async () => {
    renderAt('/settings?tab=crosspost&from=%2Fcontent%2FC1#crosspost-medium');
    const back = await screen.findByRole('link', { name: /back to your post/i });
    expect(back).toHaveAttribute('href', '/content/C1');
  });

  it('ignores a return target that points off-site', async () => {
    renderAt('/settings?tab=crosspost&from=%2F%2Fevil.example');
    await card('dev');
    expect(screen.queryByRole('link', { name: /back to your post/i })).not.toBeInTheDocument();
  });

  it('puts the cursor in the card the content page linked to', async () => {
    renderAt('/settings?tab=crosspost#crosspost-medium');
    const medium = await card('medium');
    await waitFor(() => expect(document.activeElement).toBe(within(medium).getByLabelText(/integration token/i)));
  });
});
