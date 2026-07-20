import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiFetch } from '../../auth/useApiFetch';
import { useAuth } from '../../auth/useAuth';
import { updateContent } from '../../api/content';
import {
  getReview,
  getSuggestions,
  reviewStreamingEnabled,
  startReview,
  streamReview,
  updateSuggestionStatus,
  type Review,
  type Suggestion,
} from '../../api/review';
import { applySuggestion } from '../../lib/suggestionOffsets';
import SuggestionHighlights from './SuggestionHighlights';
import SuggestionCard from './SuggestionCard';

interface Props {
  contentId: string;
  // The current draft body (content_markdown). Suggestions anchor into this.
  body: string;
  platform?: string;
  // Notifies the parent when accepting a suggestion rewrites the body, so the
  // detail view stays in sync with what was persisted.
  onBodyChange?: (body: string) => void;
}

const POLL_MS = 3000;

// The review experience for a single piece of content: kick off a "digital
// copyedit team" review, then walk its offset-anchored suggestions — accept
// (applies the edit + persists), reject, or dismiss. Accepting recomputes the
// remaining suggestions' offsets locally so the highlights stay correct between
// saves; the server re-anchors its own copy off the content stream.
export default function ContentReview({ contentId, body, platform, onBodyChange }: Props): ReactElement {
  const apiFetch = useApiFetch();
  const { getAccessToken } = useAuth();

  const [workingBody, setWorkingBody] = useState(body);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep the working copy in step with the parent's body when it changes for a
  // reason other than an accept here (e.g. the author edited it directly).
  useEffect(() => setWorkingBody(body), [body]);

  const loadSuggestions = useCallback(async () => {
    const res = await getSuggestions(apiFetch, contentId);
    setSuggestions(res.suggestions);
    setReview(res.review);
    setActiveIndex(0);
  }, [apiFetch, contentId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadSuggestions()
      .catch((err) => { if (active) setError((err as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadSuggestions]);

  // Poll while a review is in flight, then refresh the suggestions once it lands.
  const reviewId = review?.id;
  const inFlight = review?.status === 'pending' || review?.status === 'running';
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    // The stream drives its own updates; only poll for the buffered path.
    if (!inFlight || !reviewId || streaming) return;
    let active = true;
    pollRef.current = setInterval(async () => {
      try {
        const r = await getReview(apiFetch, contentId, reviewId);
        if (!active) return;
        if (r.status === 'failed') {
          setReview(r);
          if (pollRef.current) clearInterval(pollRef.current);
          return;
        }
        if (r.status === 'succeeded') {
          // Load the suggestions BEFORE stopping the poller. loadSuggestions
          // flips inFlight false (it sets the succeeded review) only once it
          // succeeds, so a transient failure here just retries on the next tick
          // instead of stranding the UI on "No suggestions" for a review that
          // actually produced some.
          await loadSuggestions();
          if (!active) return;
          if (pollRef.current) clearInterval(pollRef.current);
          return;
        }
        setReview(r); // pending / running — keep polling
      } catch {
        // transient; the next tick retries
      }
    }, POLL_MS);
    return () => {
      active = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [inFlight, reviewId, streaming, apiFetch, contentId, loadSuggestions]);

  // Live path: the Function URL creates + runs the review and streams progress
  // and the recorded suggestions. Falls back to the buffered start + poll path
  // when streaming isn't configured.
  const startStreaming = useCallback(async () => {
    setStreaming(true);
    setProgress(null);
    const done: string[] = [];
    try {
      const token = await getAccessToken();
      await streamReview(token, contentId, platform, (ev) => {
        switch (ev.type) {
          case 'review':
            setReview(ev.review);
            break;
          case 'lens':
            done.push(ev.name);
            setProgress(`Reviewed ${done.join(', ')}…`);
            break;
          case 'suggestions':
            setSuggestions(ev.suggestions);
            setActiveIndex(0);
            break;
          case 'summary':
            setReview((r) => (r ? { ...r, summary: ev.summary, lenses: { ...(r.lenses ?? {}), verdict: ev.verdict } } : r));
            break;
          case 'done':
            setReview((r) => (r ? { ...r, status: ev.status } : r));
            break;
          case 'error':
            setError(ev.message);
            break;
        }
      });
    } finally {
      setStreaming(false);
      setProgress(null);
    }
  }, [getAccessToken, contentId, platform]);

  const onStart = useCallback(async () => {
    setError(null);
    setBusy(true);
    setSuggestions([]);
    try {
      if (reviewStreamingEnabled()) {
        await startStreaming();
      } else {
        const r = await startReview(apiFetch, contentId, platform);
        setReview(r);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [apiFetch, contentId, platform, startStreaming]);

  const clampActive = useCallback((len: number, idx: number) => Math.max(0, Math.min(idx, len - 1)), []);

  const onAccept = useCallback(async () => {
    const active = suggestions[activeIndex];
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const others = suggestions.filter((s) => s.id !== active.id);
      const { newContent, updatedSuggestions } = applySuggestion(workingBody, active, others);
      // Persist the rewritten body first so it's durable.
      await updateContent(apiFetch, contentId, { content_markdown: newContent });
      // Sync local + parent state immediately on a successful save, BEFORE
      // recording the decision — so if the status call then fails, the editor
      // still reflects the applied edit (and the now-anchorless suggestion is
      // gone), matching what a reload would show. The server marks the dropped
      // suggestion skipped via the content-stream revalidation regardless.
      setWorkingBody(newContent);
      onBodyChange?.(newContent);
      setSuggestions(updatedSuggestions);
      setActiveIndex((i) => clampActive(updatedSuggestions.length, i));
      await updateSuggestionStatus(apiFetch, contentId, active.id, 'accepted');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [suggestions, activeIndex, workingBody, apiFetch, contentId, onBodyChange, clampActive]);

  const resolve = useCallback(
    async (decision: 'rejected' | 'dismissed') => {
      const active = suggestions[activeIndex];
      if (!active) return;
      setBusy(true);
      setError(null);
      try {
        await updateSuggestionStatus(apiFetch, contentId, active.id, decision);
        const remaining = suggestions.filter((s) => s.id !== active.id);
        setSuggestions(remaining);
        setActiveIndex((i) => clampActive(remaining.length, i));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [suggestions, activeIndex, apiFetch, contentId, clampActive],
  );

  const go = useCallback(
    (delta: number) => setActiveIndex((i) => (suggestions.length ? (i + delta + suggestions.length) % suggestions.length : 0)),
    [suggestions.length],
  );

  const active = suggestions[activeIndex] ?? null;

  return (
    <section className="border border-border rounded-lg px-4 py-3 space-y-3 mt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Review</h3>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onStart} disabled={busy || inFlight}>
          {inFlight ? 'Reviewing…' : suggestions.length || review ? 'Re-run review' : 'Start review'}
        </button>
      </div>

      {error && <p className="text-sm text-error-600">{error}</p>}

      {inFlight && (
        <p className="text-sm text-muted-foreground">
          {progress ?? 'Your copyedit team is reviewing the draft — suggestions will appear here shortly.'}
        </p>
      )}

      {review?.status === 'failed' && !inFlight && (
        <p className="text-sm text-error-600">The review couldn’t be completed. Try running it again.</p>
      )}

      {review?.summary && (
        <div className="bg-muted rounded-md p-3 text-sm">
          {review.lenses?.verdict && (
            <span className="mr-1 font-medium capitalize">{review.lenses.verdict.replace(/_/g, ' ')}:</span>
          )}
          {review.summary}
        </div>
      )}

      {!loading && !inFlight && suggestions.length === 0 && review?.status === 'succeeded' && (
        <p className="text-sm text-muted-foreground">No suggestions — this draft looks good.</p>
      )}

      {suggestions.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="max-h-[28rem] overflow-y-auto border border-border rounded-md bg-surface p-3">
            <SuggestionHighlights
              content={workingBody}
              suggestions={suggestions}
              activeId={active?.id ?? null}
              onSelect={(id) => setActiveIndex(suggestions.findIndex((s) => s.id === id))}
            />
          </div>
          {active && (
            <SuggestionCard
              suggestion={active}
              index={activeIndex}
              total={suggestions.length}
              busy={busy}
              onAccept={onAccept}
              onReject={() => resolve('rejected')}
              onDismiss={() => resolve('dismissed')}
              onPrev={() => go(-1)}
              onNext={() => go(1)}
            />
          )}
        </div>
      )}
    </section>
  );
}
