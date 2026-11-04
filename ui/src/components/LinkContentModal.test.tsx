import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Campaign, Content, ContentSummary } from '../api/types';

vi.mock('../auth/config', () => ({
  env: { apiBaseUrl: 'https://api.test', awsRegion: 'us-east-1', userPoolClientId: 'test' },
}));
vi.mock('../auth/useApiFetch', async (orig) => ({
  ...(await orig<typeof import('../auth/useApiFetch')>()),
  useApiFetch: () => vi.fn(),
}));
vi.mock('../api/content', () => ({
  attachContentCampaign: vi.fn(),
  detachContentCampaign: vi.fn(),
  getContent: vi.fn(),
  listAllContent: vi.fn(),
}));

const { ApiError } = await import('../auth/useApiFetch');
const { attachContentCampaign, detachContentCampaign, getContent, listAllContent } = await import('../api/content');
const { default: CampaignContentLink } = await import('../routes/campaign-detail/CampaignContentLink');

function piece(id: string, title: string, overrides: Partial<ContentSummary> = {}): ContentSummary {
  return {
    content_id: id,
    title,
    slug: title.toLowerCase().replace(/\s+/g, '-'),
    type: 'blog',
    status: 'published',
    campaign_id: null,
    publish_date: null,
    ...overrides,
  } as ContentSummary;
}

const onCampaignChange = vi.fn();

function renderLink(contentId: string | null = null): Campaign {
  const campaign = { campaign_id: 'K1', name: 'Acme launch', content_id: contentId } as Campaign;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CampaignContentLink campaign={campaign} onCampaignChange={onCampaignChange} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return campaign;
}

async function openPicker(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Link content' }));
  await screen.findByRole('option', { name: /Serverless guide/ });
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
  vi.mocked(listAllContent).mockResolvedValue({
    content: [
      piece('free', 'Serverless guide'),
      piece('taken', 'Busy post', { campaign_id: 'OTHER' }),
      piece('legacy', 'Old link', { campaign_id: 'K1' }),
    ],
    nextStartKey: null,
  });
});

describe('CampaignContentLink', () => {
  it('links the piece the user picks and updates the campaign', async () => {
    const user = userEvent.setup();
    vi.mocked(attachContentCampaign).mockResolvedValue({ content_id: 'free' } as Content);
    const campaign = renderLink();
    await openPicker(user);

    await user.click(screen.getByRole('option', { name: /Serverless guide/ }));
    await user.click(screen.getAllByRole('button', { name: 'Link content' }).at(-1) as HTMLElement);

    await waitFor(() => expect(onCampaignChange).toHaveBeenCalledWith({ ...campaign, content_id: 'free' }));
    expect(attachContentCampaign).toHaveBeenCalledWith(expect.anything(), 'free', 'K1');
  });

  it('blocks pieces linked to another campaign but keeps ones pointing here', async () => {
    const user = userEvent.setup();
    renderLink();
    await openPicker(user);

    expect(screen.getByRole('option', { name: /Busy post/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /Old link/ })).not.toHaveAttribute('aria-disabled');
    expect(screen.getByText('Already linked to another campaign')).toBeInTheDocument();
  });

  it('searches by title or slug', async () => {
    const user = userEvent.setup();
    vi.mocked(listAllContent).mockResolvedValue({
      content: [piece('free', 'Serverless guide'), piece('s', 'Other', { slug: 'hidden-slug' })],
      nextStartKey: null,
    });
    renderLink();
    await openPicker(user);

    await user.type(screen.getByRole('combobox'), 'hidden');

    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Other/ })).toBeInTheDocument();
  });

  it('explains a conflict and clears the selection', async () => {
    const user = userEvent.setup();
    vi.mocked(attachContentCampaign).mockRejectedValue(new ApiError(409, 'Conflict', null));
    renderLink();
    await openPicker(user);

    await user.click(screen.getByRole('option', { name: /Serverless guide/ }));
    const submit = screen.getAllByRole('button', { name: 'Link content' }).at(-1) as HTMLElement;
    await user.click(submit);

    expect(await screen.findByText(/already linked to another campaign\. Pick a different one/)).toBeInTheDocument();
    expect(submit).toBeDisabled();
    expect(onCampaignChange).not.toHaveBeenCalled();
  });

  it('names the linked piece and unlinks it after confirming', async () => {
    const user = userEvent.setup();
    vi.mocked(getContent).mockResolvedValue({ content_id: 'C1', title: 'Serverless guide' } as Content);
    vi.mocked(detachContentCampaign).mockResolvedValue();
    const campaign = renderLink('C1');

    expect(await screen.findByRole('link', { name: 'Serverless guide' })).toHaveAttribute('href', '/content/C1');

    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(detachContentCampaign).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole('button', { name: 'Unlink' }).at(-1) as HTMLElement);

    await waitFor(() => expect(onCampaignChange).toHaveBeenCalledWith({ ...campaign, content_id: null }));
    expect(detachContentCampaign).toHaveBeenCalledWith(expect.anything(), 'C1');
  });
});
