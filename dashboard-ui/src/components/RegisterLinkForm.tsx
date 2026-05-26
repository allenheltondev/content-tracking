import type { ReactElement } from 'react';
import { useState } from 'react';
import type { CampaignLink, CreateLinkRequest } from '../api/types';

type Role = 'main' | 'cross_post' | 'social_promo';

interface Props {
  busy: boolean;
  serverError: string | null;
  lastCreated: CampaignLink | null;
  onSubmit: (payload: CreateLinkRequest) => void;
}

export default function RegisterLinkForm({
  busy,
  serverError,
  lastCreated,
  onSubmit,
}: Props): ReactElement {
  const [role, setRole] = useState<Role>('main');
  const [platform, setPlatform] = useState('');
  const [url, setUrl] = useState('');
  const [src, setSrc] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = (): void => {
    setValidationError(null);
    const trimmedPlatform = platform.trim();
    const trimmedUrl = url.trim();
    if (trimmedPlatform.length === 0) {
      setValidationError('Platform is required.');
      return;
    }
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setValidationError('URL must start with http:// or https://.');
      return;
    }
    const payload: CreateLinkRequest = { role, platform: trimmedPlatform, url: trimmedUrl };
    if (src.trim().length > 0) payload.src = src.trim();
    onSubmit(payload);
  };

  const copyShortUrl = (): void => {
    if (!lastCreated) return;
    void navigator.clipboard.writeText(lastCreated.short_url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <fieldset className="border border-border rounded-lg px-4 py-3 space-y-3 mt-4">
      <legend className="px-1 text-sm font-medium text-foreground">Register a link</legend>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block">
          <span className="field-label">Role</span>
          <select
            className="input"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            disabled={busy}
          >
            <option value="main">main</option>
            <option value="cross_post">cross_post</option>
            <option value="social_promo">social_promo</option>
          </select>
        </label>
        <label className="block">
          <span className="field-label">Platform</span>
          <input
            type="text"
            className="input"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            placeholder="instagram, medium, ..."
            disabled={busy}
          />
        </label>
        <label className="block">
          <span className="field-label">Source label</span>
          <input
            type="text"
            className="input"
            value={src}
            onChange={(e) => setSrc(e.target.value)}
            placeholder="optional"
            disabled={busy}
          />
        </label>
      </div>

      <label className="block">
        <span className="field-label">Destination URL</span>
        <input
          type="url"
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/article"
          disabled={busy}
        />
      </label>

      {validationError && <p className="form-error">{validationError}</p>}
      {serverError && <p className="form-error">{serverError}</p>}

      <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
        {busy ? 'Registering...' : 'Register link'}
      </button>

      {lastCreated && (
        <div className="flex items-center gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm">
          <strong className="text-primary-900">Short URL:</strong>
          <code className="bg-surface border border-primary-200 rounded px-1.5 py-0.5 font-mono text-xs">
            {lastCreated.short_url}
          </code>
          <button type="button" className="btn-link" onClick={copyShortUrl}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </fieldset>
  );
}
