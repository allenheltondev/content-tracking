import type { ReactElement } from 'react';
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
vi.mock('../api/extensions', async (orig) => ({
  ...(await orig<typeof import('../api/extensions')>()),
  listExtensionPairings: vi.fn(),
  revokeExtensionPairing: vi.fn(),
}));
vi.mock('../api/apiKeys', async (orig) => ({
  ...(await orig<typeof import('../api/apiKeys')>()),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
}));
vi.mock('../api/mediaKit', async (orig) => ({
  ...(await orig<typeof import('../api/mediaKit')>()),
  listMediaKits: vi.fn(),
  getPublishState: vi.fn(),
  unpublishMediaKit: vi.fn(),
}));
vi.mock('../api/voice', async (orig) => ({
  ...(await orig<typeof import('../api/voice')>()),
  getVoiceOverview: vi.fn(),
  getVoiceProfile: vi.fn(),
  listVoiceSamples: vi.fn(),
  deleteVoiceSample: vi.fn(),
}));
vi.mock('../api/campaigns', async (orig) => ({
  ...(await orig<typeof import('../api/campaigns')>()),
  getCampaign: vi.fn(),
  getCampaignAnalytics: vi.fn(),
  getCampaignWebAnalytics: vi.fn(),
  deleteSocialPost: vi.fn(),
  deleteContentPost: vi.fn(),
}));

const { listExtensionPairings, revokeExtensionPairing } = await import('../api/extensions');
const { listApiKeys, revokeApiKey } = await import('../api/apiKeys');
const { getPublishState, listMediaKits, unpublishMediaKit } = await import('../api/mediaKit');
const { deleteVoiceSample, getVoiceOverview, getVoiceProfile, listVoiceSamples } = await import('../api/voice');
const { deleteContentPost, deleteSocialPost, getCampaign, getCampaignAnalytics, getCampaignWebAnalytics } =
  await import('../api/campaigns');
const { default: Settings } = await import('./Settings');
const { default: MediaKit } = await import('./MediaKit');
const { default: Voice } = await import('./Voice');
const { default: CampaignDetail } = await import('./CampaignDetail');

const FAILURE = 'The server said no';
const device = { jti: 'J1', label: 'Laptop', created_at: '2026-01-01T00:00:00Z', last_used_at: null };

function renderAt(url: string, path: string, element: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path={path} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Confirms in the open dialog, then expects it to stay up with the reason.
async function expectFailureInDialog(user: ReturnType<typeof userEvent.setup>, confirmLabel: string): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: confirmLabel }));

  expect(await within(dialog).findByText(FAILURE)).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(within(dialog).getByRole('button', { name: confirmLabel })).toBeEnabled();
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
});

describe('a failed confirmed action keeps its dialog open', () => {
  it('revoking an extension pairing', async () => {
    const user = userEvent.setup();
    vi.mocked(listExtensionPairings).mockResolvedValue({ pairings: [device] });
    vi.mocked(revokeExtensionPairing).mockRejectedValue(new Error(FAILURE));
    renderAt('/settings?tab=extension', '/settings', <Settings />);

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    await expectFailureInDialog(user, 'Revoke');
  });

  it('revoking an API key', async () => {
    const user = userEvent.setup();
    vi.mocked(listApiKeys).mockResolvedValue({ keys: [{ ...device, access: 'write' }] });
    vi.mocked(revokeApiKey).mockRejectedValue(new Error(FAILURE));
    renderAt('/settings?tab=api', '/settings', <Settings />);

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    await expectFailureInDialog(user, 'Revoke');
  });

  it('unpublishing the media kit', async () => {
    const user = userEvent.setup();
    vi.mocked(listMediaKits).mockResolvedValue({ media_kits: [] } as never);
    vi.mocked(getPublishState).mockResolvedValue({
      slug: 'me',
      published: true,
      url: 'https://kit.test/me',
      published_at: '2026-01-01T00:00:00Z',
    });
    vi.mocked(unpublishMediaKit).mockRejectedValue(new Error(FAILURE));
    renderAt('/media-kit', '/media-kit', <MediaKit />);

    await user.click(await screen.findByRole('button', { name: 'Unpublish' }));

    await expectFailureInDialog(user, 'Unpublish');
  });

  it('removing a voice sample', async () => {
    const user = userEvent.setup();
    vi.mocked(getVoiceOverview).mockResolvedValue({
      platforms: [
        {
          platform: 'blog',
          portrait: null,
          steering: null,
          version: 1,
          samples_since_reflection: 0,
          reflection_threshold: 5,
          recency_half_life_days: 90,
          updated_at: null,
          corpus: { recent_influence: [], by_source: {}, excluded: { muted: 0, generated: 0 } },
        },
      ],
    } as never);
    vi.mocked(getVoiceProfile).mockResolvedValue({ profile: null, reflections: [] } as never);
    vi.mocked(listVoiceSamples).mockResolvedValue({
      samples: [
        {
          sample_id: 'S1',
          platform: 'blog',
          format: 'blog',
          source: 'manual',
          text: 'A sample post',
          published_at: null,
          created_at: '2026-01-01T00:00:00Z',
          muted: false,
        },
      ],
    } as never);
    vi.mocked(deleteVoiceSample).mockRejectedValue(new Error(FAILURE));
    renderAt('/voice', '/voice', <Voice />);

    await user.click(await screen.findByRole('button', { name: /blog/i }));
    await user.click(await screen.findByRole('button', { name: 'Delete sample' }));

    await expectFailureInDialog(user, 'Remove');
  });

  it.each([
    ['social', () => vi.mocked(deleteSocialPost)],
    ['content', () => vi.mocked(deleteContentPost)],
  ])('removing a %s post', async (bucket, deletePost) => {
    const user = userEvent.setup();
    const post = { post_id: 'P1', url: 'https://example.com/post', platform: 'linkedin', engagement: null };
    vi.mocked(getCampaign).mockResolvedValue({
      campaign: { campaign_id: 'K1', name: 'Acme', status: 'active' },
      links: [],
      social_posts: bucket === 'social' ? [post] : [],
      content_posts: bucket === 'content' ? [post] : [],
      brief: null,
      draft: null,
    } as never);
    vi.mocked(getCampaignAnalytics).mockResolvedValue({} as never);
    vi.mocked(getCampaignWebAnalytics).mockResolvedValue({} as never);
    deletePost().mockRejectedValue(new Error(FAILURE));
    renderAt('/campaigns/K1?tab=promotion', '/campaigns/:campaignId', <CampaignDetail />);

    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await expectFailureInDialog(user, 'Remove');
  });
});
