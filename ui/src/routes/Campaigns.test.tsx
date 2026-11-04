import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Campaign } from '../api/types';

vi.mock('../auth/config', () => ({
  env: { apiBaseUrl: 'https://api.test', awsRegion: 'us-east-1', userPoolClientId: 'test' },
}));
vi.mock('../auth/useApiFetch', async (orig) => ({
  ...(await orig<typeof import('../auth/useApiFetch')>()),
  useApiFetch: () => vi.fn(),
}));
vi.mock('../api/campaigns', () => ({ createCampaign: vi.fn(), listCampaigns: vi.fn() }));

const { listCampaigns } = await import('../api/campaigns');
const { default: Campaigns } = await import('./Campaigns');

function campaign(id: string, name: string): Campaign {
  return {
    campaign_id: id,
    name,
    sponsor: null,
    startDate: null,
    endDate: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
  } as Campaign;
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Campaigns />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('Campaigns', () => {
  it('reaches later pages with Load more', async () => {
    const user = userEvent.setup();
    vi.mocked(listCampaigns)
      .mockResolvedValueOnce({ campaigns: [campaign('a', 'First page')], nextStartKey: 'cursor' })
      .mockResolvedValueOnce({ campaigns: [campaign('b', 'Second page')] });
    renderPage();

    await screen.findByRole('link', { name: 'First page' });
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('link', { name: 'Second page' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'First page' })).toBeInTheDocument();
    expect(listCampaigns).toHaveBeenLastCalledWith(expect.anything(), { startKey: 'cursor' });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('hides Load more when everything fits on one page', async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ campaigns: [campaign('a', 'Only page')] });
    renderPage();

    await screen.findByRole('link', { name: 'Only page' });

    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});
