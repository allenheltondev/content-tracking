import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Campaign, CampaignStatus, Content } from '../api/types';

vi.mock('../auth/config', () => ({
  env: { apiBaseUrl: 'https://api.test', awsRegion: 'us-east-1', userPoolClientId: 'test' },
}));
vi.mock('../auth/useApiFetch', async (orig) => ({
  ...(await orig<typeof import('../auth/useApiFetch')>()),
  useApiFetch: () => vi.fn(),
}));
vi.mock('../api/campaigns', () => ({ listAllCampaigns: vi.fn() }));
vi.mock('../api/content', () => ({
  attachContentCampaign: vi.fn(),
  createContentSponsorship: vi.fn(),
}));

const { ApiError } = await import('../auth/useApiFetch');
const { listAllCampaigns } = await import('../api/campaigns');
const { attachContentCampaign, createContentSponsorship } = await import('../api/content');
const { default: LinkCampaignModal } = await import('./LinkCampaignModal');

function campaign(id: string, name: string, overrides: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: id,
    name,
    sponsor: null,
    content_id: null,
    startDate: null,
    endDate: null,
    status: 'active' as CampaignStatus,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Campaign;
}

const onClose = vi.fn();
const onLinked = vi.fn();

function renderModal(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LinkCampaignModal contentId="C1" onClose={onClose} onLinked={onLinked} />
    </QueryClientProvider>,
  );
}

function optionNames(): (string | null)[] {
  return screen.getAllByRole('option').map((o) => o.querySelector('span span')?.textContent ?? null);
}

// jsdom's <dialog> has no showModal, and a closed dialog hides its content.
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
  vi.mocked(listAllCampaigns).mockResolvedValue({
    campaigns: [
      campaign('done', 'Finished deal', { status: 'completed', sponsor: 'Globex' }),
      campaign('live', 'Acme launch', { sponsor: 'Acme' }),
      campaign('taken', 'Busy campaign', { content_id: 'OTHER' }),
      campaign('mine', 'Already this piece', { status: 'draft', content_id: 'C1' }),
    ],
  });
});

describe('LinkCampaignModal', () => {
  it('lists live campaigns first and marks ones linked elsewhere as unavailable', async () => {
    renderModal();
    await screen.findByRole('option', { name: /Acme launch/ });

    expect(optionNames()).toEqual(['Acme launch', 'Already this piece', 'Finished deal', 'Busy campaign']);
    expect(screen.getByRole('option', { name: /Busy campaign/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Already linked to other content')).toBeInTheDocument();
  });

  it('filters by campaign name or sponsor', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByRole('option', { name: /Acme launch/ });

    await user.type(screen.getByRole('combobox'), 'globex');
    expect(optionNames()).toEqual(['Finished deal']);

    await user.clear(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'nothing here');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No campaigns match “nothing here”.')).toBeInTheDocument();
  });

  it('links the campaign the user clicks', async () => {
    const user = userEvent.setup();
    const updated = { content_id: 'C1', campaign_id: 'live' } as Content;
    vi.mocked(attachContentCampaign).mockResolvedValue(updated);
    renderModal();

    const submit = screen.getByRole('button', { name: 'Link campaign' });
    expect(submit).toBeDisabled();

    await user.click(await screen.findByRole('option', { name: /Acme launch/ }));
    await user.click(submit);

    await waitFor(() => expect(onLinked).toHaveBeenCalledWith('live', updated));
    expect(attachContentCampaign).toHaveBeenCalledWith(expect.anything(), 'C1', 'live');
  });

  it('never selects a campaign linked to other content', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole('option', { name: /Busy campaign/ }));

    expect(screen.getByRole('button', { name: 'Link campaign' })).toBeDisabled();
  });

  it('supports picking and confirming from the keyboard', async () => {
    const user = userEvent.setup();
    vi.mocked(attachContentCampaign).mockResolvedValue({ content_id: 'C1' } as Content);
    renderModal();
    await screen.findByRole('option', { name: /Acme launch/ });

    await user.type(screen.getByRole('combobox'), '{ArrowDown}{Enter}');
    expect(screen.getByRole('option', { name: /Already this piece/ })).toHaveAttribute('aria-selected', 'true');

    await user.type(screen.getByRole('combobox'), '{Enter}');
    await waitFor(() => expect(attachContentCampaign).toHaveBeenCalledWith(expect.anything(), 'C1', 'mine'));
  });

  it('explains a conflict and clears the selection when the campaign was just taken', async () => {
    const user = userEvent.setup();
    vi.mocked(attachContentCampaign).mockRejectedValue(new ApiError(409, 'Campaign live is attached', null));
    renderModal();

    await user.click(await screen.findByRole('option', { name: /Acme launch/ }));
    await user.click(screen.getByRole('button', { name: 'Link campaign' }));

    expect(await screen.findByText(/already linked to other content\. Pick a different one/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link campaign' })).toBeDisabled();
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('creates a campaign from the search text without leaving the dialog', async () => {
    const user = userEvent.setup();
    vi.mocked(createContentSponsorship).mockResolvedValue(campaign('new', 'Initech Q4'));
    renderModal();
    await screen.findByRole('option', { name: /Acme launch/ });

    await user.type(screen.getByRole('combobox'), 'Initech Q4');
    await user.click(screen.getByRole('button', { name: 'Create new campaign' }));

    const dialog = screen.getByRole('dialog', { name: 'New campaign' });
    expect(within(dialog).getByLabelText('Campaign name')).toHaveValue('Initech Q4');

    await user.click(within(dialog).getByRole('button', { name: 'Create and link' }));

    await waitFor(() => expect(onLinked).toHaveBeenCalledWith('new', undefined));
    expect(createContentSponsorship).toHaveBeenCalledWith(expect.anything(), 'C1', { name: 'Initech Q4' });
  });
});
