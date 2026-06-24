import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import { useApiFetch } from '../auth/useApiFetch';
import { useAuth } from '../auth/useAuth';
import {
  PLATFORM_CHAR_LIMITS,
  VOICE_PLATFORMS,
  composeVoice,
  createVoiceSample,
  platformLabel,
} from '../api/voice';
import { streamGenerate, streamingEnabled } from '../api/stream';
import type { VoiceFormat } from '../api/types';
import CopyButton from '../components/CopyButton';
import Markdown from '../components/MarkdownLazy';

// "blog" is inherently long-form, so it pins the format.
function formatFor(platform: string, chosen: VoiceFormat): VoiceFormat {
  return platform === 'blog' ? 'blog' : chosen;
}

function PlatformSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {VOICE_PLATFORMS.map((p) => (
        <option key={p} value={p}>{platformLabel(p)}</option>
      ))}
    </select>
  );
}

export default function Compose(): ReactElement {
  const apiFetch = useApiFetch();
  const { getAccessToken } = useAuth();

  const [topic, setTopic] = useState('');
  const [platform, setPlatform] = useState<string>('x');
  const [format, setFormat] = useState<VoiceFormat>('social');
  const [guidance, setGuidance] = useState('');

  // The draft is editable: tweak it before copying or saving so the voice
  // learns from what you'd actually publish, not the raw model output.
  const [hasDraft, setHasDraft] = useState(false);
  const [editedPost, setEditedPost] = useState('');
  const [editedTitle, setEditedTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [preview, setPreview] = useState(false);

  const effectiveFormat = formatFor(platform, format);
  const trimmed = topic.trim();
  const limit = effectiveFormat === 'social' ? PLATFORM_CHAR_LIMITS[platform] : undefined;
  const over = limit !== undefined && editedPost.length > limit;
  const composedText = editedTitle ? `${editedTitle}\n\n${editedPost}` : editedPost;

  const runCompose = async (): Promise<void> => {
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setSaveState('idle');
    const body = {
      mode: 'compose',
      topic: trimmed,
      platform,
      format: effectiveFormat,
      guidance: guidance.trim() || undefined,
    };
    try {
      if (streamingEnabled()) {
        // Stream tokens in live — the draft types itself out.
        setEditedTitle('');
        setEditedPost('');
        setHasDraft(true);
        const token = await getAccessToken();
        let acc = '';
        await streamGenerate(token, body, (text) => {
          acc += text;
          setEditedPost(acc);
        });
        if (acc.length === 0) setHasDraft(false);
      } else {
        const res = await composeVoice(apiFetch, {
          topic: trimmed,
          platform,
          format: effectiveFormat,
          guidance: guidance.trim() || undefined,
        });
        setEditedPost(res.post);
        setEditedTitle(res.title ?? '');
        setHasDraft(true);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void runCompose();
  };

  const editDraft = (next: { post?: string; title?: string }): void => {
    if (next.post !== undefined) setEditedPost(next.post);
    if (next.title !== undefined) setEditedTitle(next.title);
    setSaveState('idle');
  };

  // Saving teaches the voice — the saved post becomes a future few-shot example
  // and counts toward the next reflection. We save the EDITED text.
  const saveDraft = async (): Promise<void> => {
    if (editedPost.trim().length === 0) return;
    setSaveState('saving');
    try {
      await createVoiceSample(apiFetch, {
        text: composedText,
        platform,
        format: effectiveFormat,
        source: 'generated',
      });
      setSaveState('saved');
    } catch (err) {
      setError((err as Error).message);
      setSaveState('idle');
    }
  };

  return (
    <section className="space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">Compose in your voice</h1>
        <p className="text-sm text-muted-foreground">
          Draft a post that sounds like you. It learns from your saved posts per platform — tweak
          and save the drafts you like to make it better over time.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className="field-label">Topic</span>
          <textarea
            className="input"
            rows={2}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. Why I stopped writing integration tests for everything"
            disabled={busy}
          />
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="field-label">Platform</span>
            <PlatformSelect value={platform} onChange={setPlatform} disabled={busy} />
          </label>
          <label className="block">
            <span className="field-label">Format</span>
            <select
              className="input"
              value={effectiveFormat}
              onChange={(e) => setFormat(e.target.value as VoiceFormat)}
              disabled={busy || platform === 'blog'}
            >
              <option value="social">Short / social</option>
              <option value="blog">Long-form / blog</option>
            </select>
          </label>
        </div>

        <label className="block">
          <span className="field-label">Guidance (optional)</span>
          <input
            type="text"
            className="input"
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            placeholder="e.g. keep it under 3 sentences, end with a question"
            disabled={busy}
          />
        </label>

        <button type="submit" className="btn-primary" disabled={busy || trimmed.length === 0}>
          {busy ? 'Composing…' : hasDraft ? 'Compose again' : 'Compose'}
        </button>
      </form>

      {error && <p className="form-error">{error}</p>}

      {hasDraft && (
        <div className="card card-body space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-foreground">Draft</h2>
            <div className="flex items-center gap-2">
              {effectiveFormat === 'blog' && !busy && editedPost.length > 0 && (
                <button
                  type="button"
                  className="btn-link text-xs"
                  onClick={() => setPreview((v) => !v)}
                >
                  {preview ? 'Edit' : 'Preview'}
                </button>
              )}
              <span className="text-xs text-muted-foreground">
                {busy ? 'writing…' : `${platformLabel(platform)} · editable`}
              </span>
            </div>
          </div>

          {effectiveFormat === 'blog' && (editedTitle.length > 0 || !streamingEnabled()) && !preview && (
            <input
              type="text"
              className="input font-medium"
              value={editedTitle}
              onChange={(e) => editDraft({ title: e.target.value })}
              placeholder="Title"
              disabled={busy}
            />
          )}

          {effectiveFormat === 'blog' && preview && !busy ? (
            <div className="rounded-md border border-border p-3 text-sm">
              <Markdown>{composedText}</Markdown>
            </div>
          ) : (
            <textarea
              className="input whitespace-pre-wrap"
              rows={effectiveFormat === 'blog' ? 14 : 5}
              value={editedPost}
              onChange={(e) => editDraft({ post: e.target.value })}
              disabled={busy}
            />
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <CopyButton text={composedText} />
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => void runCompose()}
                disabled={busy}
              >
                {busy ? 'Regenerating…' : 'Regenerate'}
              </button>
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => void saveDraft()}
                disabled={saveState !== 'idle' || editedPost.trim().length === 0}
              >
                {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : 'Save to voice'}
              </button>
            </div>
            {limit !== undefined && (
              <span className={`text-xs tabular-nums ${over ? 'text-error-600' : 'text-muted-foreground'}`}>
                {editedPost.length} / {limit}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Saving teaches your {platformLabel(platform)} voice and counts toward the next refresh.
          </p>
        </div>
      )}

      <TeachSample />
    </section>
  );
}

// Paste an existing post you wrote to seed the voice without generating one.
function TeachSample(): ReactElement {
  const apiFetch = useApiFetch();
  const [text, setText] = useState('');
  const [platform, setPlatform] = useState<string>('x');
  const [format, setFormat] = useState<VoiceFormat>('social');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  const effectiveFormat = formatFor(platform, format);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (text.trim().length === 0 || state === 'saving') return;
    setState('saving');
    setError(null);
    try {
      await createVoiceSample(apiFetch, { text: text.trim(), platform, format: effectiveFormat, source: 'manual' });
      setText('');
      setState('saved');
    } catch (err) {
      setError((err as Error).message);
      setState('idle');
    }
  };

  return (
    <form onSubmit={save} className="card card-body space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Teach a sample</h2>
        <p className="text-sm text-muted-foreground">
          Paste a post you already wrote to teach your voice directly.
        </p>
      </div>
      <textarea
        className="input"
        rows={4}
        value={text}
        onChange={(e) => { setText(e.target.value); setState('idle'); }}
        placeholder="Paste an existing post in your voice…"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <PlatformSelect value={platform} onChange={setPlatform} />
        <select
          className="input"
          value={effectiveFormat}
          onChange={(e) => setFormat(e.target.value as VoiceFormat)}
          disabled={platform === 'blog'}
        >
          <option value="social">Short / social</option>
          <option value="blog">Long-form / blog</option>
        </select>
      </div>
      {error && <p className="form-error">{error}</p>}
      <button type="submit" className="btn-secondary" disabled={state === 'saving' || text.trim().length === 0}>
        {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : 'Save sample'}
      </button>
    </form>
  );
}
