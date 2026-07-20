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
vi.mock('../../api/content', () => ({ updateContent: vi.fn() }));
vi.mock('../../api/review', () => ({
  getSuggestions: vi.fn(),
  getReview: vi.fn(),
  startReview: vi.fn(),
  updateSuggestionStatus: vi.fn(),
}));

const { updateContent } = await import('../../api/content');
const { getSuggestions, updateSuggestionStatus } = await import('../../api/review');
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
