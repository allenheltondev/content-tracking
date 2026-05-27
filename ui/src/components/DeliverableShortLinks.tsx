import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { ApiError } from '../auth/useApiFetch';
import type { CampaignLink, CreateLinkRequest, Deliverable } from '../api/types';

type Role = 'main' | 'cross_post' | 'social_promo';

interface Props {
  deliverable: Deliverable;
  createShortLink: (payload: CreateLinkRequest) => Promise<CampaignLink>;
}

const SOCIAL_PLATFORMS = ['twitter', 'linkedin', 'instagram'];

function normalizePlatform(raw: string): string {
  const p = raw.trim().toLowerCase();
  if (p === 'x' || p === 'x.com' || p === 'twitter.com') return 'twitter';
  return p;
}

function platformLabel(p: string): string {
  if (p === 'twitter') return 'X / Twitter';
  return p.length === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1);
}

// A loose mapping from the brief's free-text deliverable type to the link
// role enum, just to seed a sensible default. The user can override.
function defaultRole(type: string): Role {
  const t = type.toLowerCase();
  if (/cross|repost|repurpose|syndicat/.test(t)) return 'cross_post';
  if (/post|story|reel|tweet|thread|short/.test(t)) return 'social_promo';
  return 'main';
}

export default function DeliverableShortLinks({ deliverable, createShortLink }: Props): ReactElement {
  const ownPlatform = normalizePlatform(deliverable.platform ?? '');

  const platformOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [ownPlatform, ...SOCIAL_PLATFORMS]) {
      if (p.length > 0 && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }, [ownPlatform]);

  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [role, setRole] = useState<Role>(defaultRole(deliverable.type ?? ''));
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(ownPlatform.length > 0 ? [ownPlatform] : []),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<CampaignLink[]>([]);

  const label = [
    deliverable.count && deliverable.count > 1 ? `${deliverable.count}×` : null,
    deliverable.platform,
    deliverable.type,
  ]
    .filter(Boolean)
    .join(' ');

  const togglePlatform = (p: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    setError(null);
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setError('Enter the URL of the content you created (must start with http:// or https://).');
      return;
    }
    if (selected.size === 0) {
      setError('Pick at least one platform to create a short link for.');
      return;
    }

    setBusy(true);
    const created: CampaignLink[] = [];
    let failure: string | null = null;
    // Mint one short link per platform so the existing by-platform click
    // analytics can attribute clicks to each post. Stop on the first
    // failure but keep whatever already succeeded.
    for (const platform of selected) {
      try {
        created.push(await createShortLink({ role, platform, url: trimmed, src: platform }));
      } catch (err) {
        failure = err instanceof ApiError ? err.message : (err as Error).message;
        break;
      }
    }
    if (created.length > 0) setMinted((prev) => [...prev, ...created]);
    if (failure) {
      setError(failure);
    } else {
      setOpen(false);
      setUrl('');
    }
    setBusy(false);
  };

  return (
    <div className="rounded-lg border border-border px-3 py-2.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium text-foreground">{label}</span>
          {deliverable.notes && <span className="text-muted-foreground">— {deliverable.notes}</span>}
        </div>
        {!open && (
          <button type="button" className="btn-link" onClick={() => setOpen(true)}>
            {minted.length > 0 ? 'Add another short link' : 'Create short link'}
          </button>
        )}
      </div>

      {open && (
        <div className="space-y-3 pt-1">
          <label className="block">
            <span className="field-label">Link to the content you created</span>
            <input
              type="url"
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/the-article"
              disabled={busy}
            />
          </label>

          <div>
            <span className="field-label">Create a short link for</span>
            <div className="flex flex-wrap gap-2">
              {platformOptions.map((p) => {
                const active = selected.has(p);
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={busy}
                    aria-pressed={active}
                    onClick={() => togglePlatform(p)}
                    className={
                      active
                        ? 'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium bg-primary-600 text-white'
                        : 'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium bg-muted text-foreground hover:bg-secondary-200'
                    }
                  >
                    {platformLabel(p)}
                  </button>
                );
              })}
            </div>
            <span className="field-hint">One trackable short link is minted per platform.</span>
          </div>

          <label className="block max-w-[12rem]">
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

          {error && <p className="form-error">{error}</p>}

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? 'Creating…' : 'Create short link'}
            </button>
            <button
              type="button"
              className="btn-link"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {minted.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <p className="text-xs font-medium text-foreground">Short links — paste into your posts:</p>
          <ul className="space-y-1.5">
            {minted.map((link) => (
              <li key={link.link_id}>
                <ShortLinkRow platform={link.platform} shortUrl={link.short_url} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ShortLinkRow({ platform, shortUrl }: { platform: string; shortUrl: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary-200 bg-primary-50 px-2.5 py-1.5 text-sm">
      <span className="status-pill bg-primary-100 text-primary-800">{platformLabel(platform)}</span>
      <code className="bg-surface border border-primary-200 rounded px-1.5 py-0.5 font-mono text-xs text-foreground">
        {shortUrl}
      </code>
      <button
        type="button"
        className="btn-link ml-auto"
        onClick={() => {
          void navigator.clipboard.writeText(shortUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
