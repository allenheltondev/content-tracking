import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Suggestion } from '../../api/review';

// Mock the auth fetch hook and the API modules so the test drives the component's
// orchestration (load → accept → persist) without the network.
// Return a STABLE apiFetch reference (the real hook is useCallback-stable), so
// the component's load effect doesn't re-fire on every render.
vi.mock('../../auth/useApiFetch', () => {
  const apiFetch = async () => undefined;
  return { useApiFetch: () => apiFetch };
});
vi.mock('../../auth/useAuth', () => ({ useAuth: () => ({ getAccessToken: async () => 'tok' }) }));
vi.mock('../../api/content', () => ({ updateContent: vi.fn() }));
vi.mock('../../api/review', () => ({
  getSuggestions: vi.fn(),
  getReview: vi.fn(),
  startReview: vi.fn(),
  streamReview: vi.fn(),
  reviewStreamingEnabled: vi.fn(() => false),
  updateSuggestionStatus: vi.fn(),
}));

const { updateContent } = await import('../../api/content');
const { getSuggestions, updateSuggestionStatus, streamReview, reviewStreamingEnabled } = await import('../../api/review');
const ContentReview = (await import('./ContentReview')).default;

const BODY = 'The quick brown fox.';
const SUGGESTION: Suggestion = {
  id: 's1',
  reviewId: 'r1',
  type: 'grammar',
  priority: 'medium',
  reason: 'Prefer a stronger word.',
  startOffset: BODY.indexOf('quick'),
  endOffset: BODY.indexOf('quick') + 5,
  textToReplace: 'quick',
  replaceWith: 'swift',
  contextBefore: 'The ',
  contextAfter: ' brown',
  createdAt: '2026-07-19T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  (getSuggestions as ReturnType<typeof vi.fn>).mockResolvedValue({
    suggestions: [SUGGESTION],
    review: { id: 'r1', status: 'succeeded', summary: 'Looks solid.', lenses: { verdict: 'minor_revisions' }, createdAt: '', updatedAt: '' },
  });
  (updateContent as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (updateSuggestionStatus as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

describe('ContentReview', () => {
  it('loads pending suggestions and shows the summary', async () => {
    render(<ContentReview contentId="C1" body={BODY} />);
    expect(await screen.findByText('Prefer a stronger word.')).toBeInTheDocument();
    expect(screen.getByText(/Looks solid\./)).toBeInTheDocument();
    expect(screen.getByText(/minor revisions/i)).toBeInTheDocument();
  });

  it('accepting applies the edit, persists the new body, records the decision, and notifies the parent', async () => {
    const onBodyChange = vi.fn();
    render(<ContentReview contentId="C1" body={BODY} onBodyChange={onBodyChange} />);

    await screen.findByText('Prefer a stronger word.');
    await userEvent.click(screen.getByRole('button', { name: /^accept$/i }));

    await waitFor(() => {
      expect(updateContent).toHaveBeenCalledWith(expect.anything(), 'C1', { content_markdown: 'The swift brown fox.' });
    });
    expect(updateSuggestionStatus).toHaveBeenCalledWith(expect.anything(), 'C1', 's1', 'accepted');
    expect(onBodyChange).toHaveBeenCalledWith('The swift brown fox.');
    // The applied suggestion leaves the list.
    await waitFor(() => expect(screen.queryByText('Prefer a stronger word.')).not.toBeInTheDocument());
  });

  it('keeps the applied edit in sync even when recording the decision fails', async () => {
    (updateSuggestionStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'));
    const onBodyChange = vi.fn();
    render(<ContentReview contentId="C1" body={BODY} onBodyChange={onBodyChange} />);

    await screen.findByText('Prefer a stronger word.');
    await userEvent.click(screen.getByRole('button', { name: /^accept$/i }));

    await waitFor(() => {
      expect(updateContent).toHaveBeenCalledWith(expect.anything(), 'C1', { content_markdown: 'The swift brown fox.' });
    });
    // Body synced + suggestion dropped despite the failed status call.
    expect(onBodyChange).toHaveBeenCalledWith('The swift brown fox.');
    await waitFor(() => expect(screen.queryByText('Prefer a stronger word.')).not.toBeInTheDocument());
  });

  it('uses the live stream when enabled, rendering streamed suggestions and summary', async () => {
    (getSuggestions as ReturnType<typeof vi.fn>).mockResolvedValue({ suggestions: [], review: null });
    (reviewStreamingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (streamReview as ReturnType<typeof vi.fn>).mockImplementation(async (_t, _c, _p, onEvent) => {
      onEvent({ type: 'review', review: { id: 'r9', status: 'pending', summary: null, lenses: null, createdAt: '', updatedAt: '' } });
      onEvent({ type: 'lens', name: 'readability', count: 1 });
      onEvent({ type: 'suggestions', suggestions: [SUGGESTION] });
      onEvent({ type: 'summary', summary: 'Streamed summary.', verdict: 'minor_revisions' });
      onEvent({ type: 'done', status: 'succeeded' });
    });

    render(<ContentReview contentId="C1" body={BODY} />);
    // No pending suggestions initially; the review is streamed on Start.
    await waitFor(() => expect(screen.getByRole('button', { name: /start review/i })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /start review/i }));

    expect(await screen.findByText('Prefer a stronger word.')).toBeInTheDocument();
    expect(screen.getByText(/Streamed summary\./)).toBeInTheDocument();
    expect(streamReview).toHaveBeenCalledWith('tok', 'C1', undefined, expect.any(Function));
  });

  it('inline edit applies the edited replacement instead of the suggested text', async () => {
    const onBodyChange = vi.fn();
    render(<ContentReview contentId="C1" body={BODY} onBodyChange={onBodyChange} />);

    await screen.findByText('Prefer a stronger word.');
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    const textarea = screen.getByRole('textbox', { name: /edit replacement text/i });
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'nimble');
    await userEvent.click(screen.getByRole('button', { name: /accept edit/i }));

    await waitFor(() => {
      expect(updateContent).toHaveBeenCalledWith(expect.anything(), 'C1', { content_markdown: 'The nimble brown fox.' });
    });
    expect(onBodyChange).toHaveBeenCalledWith('The nimble brown fox.');
  });

  it('undo restores the pre-accept body and re-inserts the suggestion', async () => {
    render(<ContentReview contentId="C1" body={BODY} />);

    await screen.findByText('Prefer a stronger word.');
    await userEvent.click(screen.getByRole('button', { name: /^accept$/i }));
    await waitFor(() => expect(screen.queryByText('Prefer a stronger word.')).not.toBeInTheDocument());

    // Undo appears after an accept; clicking it reverts.
    await userEvent.click(screen.getByRole('button', { name: /^undo$/i }));

    await waitFor(() => {
      expect(updateContent).toHaveBeenLastCalledWith(expect.anything(), 'C1', { content_markdown: BODY });
    });
    expect(await screen.findByText('Prefer a stronger word.')).toBeInTheDocument();
  });

  it('rejecting records the decision without touching the body', async () => {
    render(<ContentReview contentId="C1" body={BODY} />);
    await screen.findByText('Prefer a stronger word.');
    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));

    await waitFor(() => {
      expect(updateSuggestionStatus).toHaveBeenCalledWith(expect.anything(), 'C1', 's1', 'rejected');
    });
    expect(updateContent).not.toHaveBeenCalled();
  });
});
