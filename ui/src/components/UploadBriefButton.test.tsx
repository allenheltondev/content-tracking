import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Campaign } from '../api/types';

vi.mock('../auth/config', () => ({
  env: { apiBaseUrl: 'https://api.test', awsRegion: 'us-east-1', userPoolClientId: 'test' },
}));
vi.mock('../auth/useApiFetch', async (orig) => ({
  ...(await orig<typeof import('../auth/useApiFetch')>()),
  useApiFetch: () => vi.fn(),
}));
vi.mock('../api/briefs', async (orig) => ({
  ...(await orig<typeof import('../api/briefs')>()),
  requestStagedBriefUpload: vi.fn(),
  uploadBriefFile: vi.fn(),
  createCampaignFromBrief: vi.fn(),
}));

const { ApiError } = await import('../auth/useApiFetch');
const { createCampaignFromBrief, requestStagedBriefUpload, uploadBriefFile } = await import('../api/briefs');
const { default: UploadBriefButton } = await import('./UploadBriefButton');

const pdf = new File(['brief'], 'Acme deal.pdf', { type: 'application/pdf' });
const docx = new File(['brief'], 'Acme deal.docx', { type: '' });

function Where(): ReactElement {
  const { pathname, search } = useLocation();
  return <p>At {pathname + search}</p>;
}

function renderButton(): void {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<UploadBriefButton className="btn" />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function pick(user: ReturnType<typeof userEvent.setup>, file: File): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Upload brief' }));
  await user.upload(screen.getByLabelText('Brief file'), file);
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
  vi.mocked(requestStagedBriefUpload).mockResolvedValue({
    upload_id: 'U1',
    upload_url: 'https://s3/put',
    expires_at: 'soon',
  });
  vi.mocked(uploadBriefFile).mockResolvedValue();
  vi.mocked(createCampaignFromBrief).mockResolvedValue({ campaign_id: 'K1' } as Campaign);
});

describe('UploadBriefButton', () => {
  it('uploads the file, creates the campaign, and opens its Brief tab', async () => {
    const user = userEvent.setup();
    renderButton();

    await pick(user, pdf);

    expect(await screen.findByText('At /campaigns/K1?tab=brief')).toBeInTheDocument();
    expect(uploadBriefFile).toHaveBeenCalledWith('https://s3/put', pdf, 'pdf');
    expect(createCampaignFromBrief).toHaveBeenCalledWith(expect.anything(), {
      uploadId: 'U1',
      format: 'pdf',
      fileName: 'Acme deal.pdf',
    });
  });

  it('accepts a Word file the browser reports no type for', async () => {
    const user = userEvent.setup();
    renderButton();

    await pick(user, docx);

    await waitFor(() => expect(requestStagedBriefUpload).toHaveBeenCalledWith(expect.anything(), 'docx'));
  });

  it('rejects other file types before uploading', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderButton();

    await pick(user, new File(['x'], 'notes.txt', { type: 'text/plain' }));

    expect(await screen.findByText(/Only PDF and Word/)).toBeInTheDocument();
    expect(requestStagedBriefUpload).not.toHaveBeenCalled();
  });

  it('shows progress and blocks closing while the brief is read', async () => {
    const user = userEvent.setup();
    vi.mocked(createCampaignFromBrief).mockReturnValue(new Promise(() => {}));
    renderButton();

    await pick(user, pdf);

    expect(await screen.findByText(/Reading the brief/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.getByText(/Reading the brief/)).toBeInTheDocument();
  });

  it('stays open with the reason when reading fails, so the user can retry', async () => {
    const user = userEvent.setup();
    vi.mocked(createCampaignFromBrief).mockRejectedValue(new ApiError(502, 'bad output', null));
    renderButton();

    await pick(user, pdf);

    expect(await screen.findByText(/couldn't parse the brief/)).toBeInTheDocument();
    expect(screen.getByLabelText('Brief file')).toBeEnabled();
  });
});
