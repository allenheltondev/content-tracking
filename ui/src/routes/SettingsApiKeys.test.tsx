import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../auth/config', () => ({
  env: { apiBaseUrl: 'https://api.test', awsRegion: 'us-east-1', userPoolClientId: 'test' },
}));
vi.mock('../auth/useApiFetch', async (orig) => ({
  ...(await orig<typeof import('../auth/useApiFetch')>()),
  useApiFetch: () => vi.fn(),
}));
vi.mock('../api/apiKeys', async (orig) => ({
  ...(await orig<typeof import('../api/apiKeys')>()),
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

const { listApiKeys, createApiKey } = await import('../api/apiKeys');
const { default: Settings } = await import('./Settings');

const created = '2026-11-01T00:00:00Z';

function renderApiTab(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings?tab=api']}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// jsdom has no <dialog> modal support; the design system's Modal needs it.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Settings API keys access levels', () => {
  it('shows each key with its access level', async () => {
    vi.mocked(listApiKeys).mockResolvedValue({
      keys: [
        { jti: 'J1', label: 'muse', access: 'read', created_at: created, last_used_at: null },
        { jti: 'J2', label: 'writing-repo', access: 'write', created_at: created, last_used_at: null },
      ],
    });
    renderApiTab();

    const museRow = (await screen.findByText('muse')).closest('tr') as HTMLElement;
    expect(within(museRow).getByText('Read only')).toBeInTheDocument();
    const repoRow = screen.getByText('writing-repo').closest('tr') as HTMLElement;
    expect(within(repoRow).getByText('Read and write')).toBeInTheDocument();
  });

  it('creates a read-only key by default', async () => {
    const user = userEvent.setup();
    vi.mocked(listApiKeys).mockResolvedValue({ keys: [] });
    vi.mocked(createApiKey).mockResolvedValue({
      jti: 'J3', label: 'muse', access: 'read', created_at: created, last_used_at: null, key: 'secret',
    });
    renderApiTab();

    await user.click(await screen.findByRole('button', { name: 'Create a new API key' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox')).toHaveValue('read');
    await user.type(within(dialog).getByRole('textbox'), 'muse');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));

    expect(createApiKey).toHaveBeenCalledWith(expect.anything(), { label: 'muse', access: 'read' });
  });

  it('creates a read and write key when chosen', async () => {
    const user = userEvent.setup();
    vi.mocked(listApiKeys).mockResolvedValue({ keys: [] });
    vi.mocked(createApiKey).mockResolvedValue({
      jti: 'J4', label: 'API key', access: 'write', created_at: created, last_used_at: null, key: 'secret',
    });
    renderApiTab();

    await user.click(await screen.findByRole('button', { name: 'Create a new API key' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByRole('combobox'), 'write');
    expect(within(dialog).getByText(/creates, edits, and deletes campaign data/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));

    expect(createApiKey).toHaveBeenCalledWith(expect.anything(), { label: undefined, access: 'write' });
  });
});
