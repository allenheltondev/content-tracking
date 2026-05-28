import type { ReactElement } from 'react';
import { useState } from 'react';
import type { ContentPlatform, CreateContentPostRequest } from '../api/types';

interface Props {
  busy: boolean;
  serverError: string | null;
  onSubmit: (payload: CreateContentPostRequest) => void;
  onCancel?: () => void;
}

// Infers the platform from a content URL the same way the API does, so
// the dropdown defaults sensibly and the user rarely has to touch it.
function inferPlatform(url: string): ContentPlatform | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
  if (host === 'medium.com' || host.endsWith('.medium.com')) return 'medium';
  if (host === 'dev.to' || host.endsWith('.dev.to')) return 'devto';
  return undefined;
}

export default function RegisterContentPostForm({ busy, serverError, onSubmit, onCancel }: Props): ReactElement {
  const [url, setUrl] = useState('');
  const [platform, setPlatform] = useState<ContentPlatform | ''>('');
  const [notes, setNotes] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = (): void => {
    setValidationError(null);
    const trimmedUrl = url.trim();
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setValidationError('URL must start with http:// or https://.');
      return;
    }
    const resolved = platform || inferPlatform(trimmedUrl);
    if (!resolved) {
      setValidationError('Could not infer the platform from this URL. Pick one below.');
      return;
    }
    const payload: CreateContentPostRequest = { url: trimmedUrl, platform: resolved };
    if (notes.trim().length > 0) payload.notes = notes.trim();
    onSubmit(payload);
    setUrl('');
    setNotes('');
    setPlatform('');
  };

  return (
    <fieldset className="border border-border rounded-lg px-4 py-3 space-y-3 mt-4">
      <legend className="px-1 text-sm font-medium text-foreground">Track a content post</legend>

      <label className="block">
        <span className="field-label">Post URL</span>
        <input
          type="url"
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://medium.com/@you/post-title-abc123…"
          disabled={busy}
        />
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="field-label">Platform</span>
          <select
            className="input"
            value={platform}
            onChange={(e) => setPlatform(e.target.value as ContentPlatform | '')}
            disabled={busy}
          >
            <option value="">auto-detect</option>
            <option value="medium">medium</option>
            <option value="devto">dev.to</option>
          </select>
        </label>
        <label className="block">
          <span className="field-label">Notes</span>
          <input
            type="text"
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="optional"
            disabled={busy}
          />
        </label>
      </div>

      {validationError && <p className="form-error">{validationError}</p>}
      {serverError && <p className="form-error">{serverError}</p>}

      <div className="flex items-center gap-2">
        <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Adding…' : 'Track post'}
        </button>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </fieldset>
  );
}
