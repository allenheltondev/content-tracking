import type { ReactElement } from 'react';
import { useState } from 'react';
import type { CreateSocialPostRequest, SocialPlatform } from '../api/types';

interface Props {
  busy: boolean;
  serverError: string | null;
  onSubmit: (payload: CreateSocialPostRequest) => void;
  onCancel?: () => void;
}

// Infers the platform from a post URL the same way the API does, so the
// "platform" dropdown defaults sensibly and the user rarely has to touch
// it. Returns undefined when the host isn't one we recognize.
function inferPlatform(url: string): SocialPlatform | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
  if (host === 'twitter.com' || host === 'x.com' || host.endsWith('.twitter.com')) return 'twitter';
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (host === 'bsky.app' || host.endsWith('.bsky.app')) return 'bluesky';
  return undefined;
}

export default function RegisterSocialPostForm({ busy, serverError, onSubmit, onCancel }: Props): ReactElement {
  const [url, setUrl] = useState('');
  const [platform, setPlatform] = useState<SocialPlatform | ''>('');
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
    const payload: CreateSocialPostRequest = { url: trimmedUrl, platform: resolved };
    if (notes.trim().length > 0) payload.notes = notes.trim();
    onSubmit(payload);
    setUrl('');
    setNotes('');
    setPlatform('');
  };

  return (
    <fieldset className="border border-border rounded-lg px-4 py-3 space-y-3 mt-4">
      <legend className="px-1 text-sm font-medium text-foreground">Track a social post</legend>

      <label className="block">
        <span className="field-label">Post URL</span>
        <input
          type="url"
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://x.com/you/status/123…"
          disabled={busy}
        />
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="field-label">Platform</span>
          <select
            className="input"
            value={platform}
            onChange={(e) => setPlatform(e.target.value as SocialPlatform | '')}
            disabled={busy}
          >
            <option value="">auto-detect</option>
            <option value="twitter">twitter / x</option>
            <option value="linkedin">linkedin</option>
            <option value="instagram">instagram</option>
            <option value="bluesky">bluesky</option>
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
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Adding…' : 'Track post'}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </fieldset>
  );
}
