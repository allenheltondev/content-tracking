import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import { getProfile, updateProfile } from '../api/profile';
import {
  createExtensionPairing,
  listExtensionPairings,
  revokeExtensionPairing,
} from '../api/extensions';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../api/apiKeys';
import type {
  ApiKey,
  CreateApiKeyResponse,
  CreateExtensionPairingResponse,
  ExtensionPairing,
  ProfileResponse,
  ProfileUpdateRequest,
} from '../api/types';
import Modal from '../components/Modal';
import {
  CROSSPOST_PLATFORM_LABELS,
  CROSSPOST_SETTINGS_KEY,
  getCrosspostSettings,
  safeReturnPath,
  updateCrosspostSettings,
} from '../api/crosspostSettings';
import { CROSSPOST_PLATFORMS } from '../api/content';
import type {
  CrosspostPlatform,
  CrosspostPlatformReadiness,
  CrosspostPlatformUpdate,
} from '../api/types';

type SettingsTab = 'integrations' | 'crosspost' | 'extension' | 'api';

const TAB_PARAM = 'tab';

function parseTab(value: string | null): SettingsTab {
  if (value === 'crosspost') return 'crosspost';
  if (value === 'extension') return 'extension';
  if (value === 'api') return 'api';
  return 'integrations';
}

export default function Settings(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = parseTab(searchParams.get(TAB_PARAM));

  const selectTab = (tab: SettingsTab): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (tab === 'integrations') next.delete(TAB_PARAM);
        else next.set(TAB_PARAM, tab);
        return next;
      },
      { replace: true },
    );
  };

  return (
    <section className="space-y-6 max-w-3xl">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
      </header>

      <nav className="border-b border-border flex gap-1" aria-label="Settings sections">
        <TabButton
          label="Integrations"
          active={activeTab === 'integrations'}
          onClick={() => selectTab('integrations')}
        />
        <TabButton
          label="Cross-posting"
          active={activeTab === 'crosspost'}
          onClick={() => selectTab('crosspost')}
        />
        <TabButton
          label="Extension"
          active={activeTab === 'extension'}
          onClick={() => selectTab('extension')}
        />
        <TabButton
          label="API keys"
          active={activeTab === 'api'}
          onClick={() => selectTab('api')}
        />
      </nav>

      {activeTab === 'integrations' && <IntegrationsTab />}
      {activeTab === 'crosspost' && <CrosspostTab />}
      {activeTab === 'extension' && <ExtensionTab />}
      {activeTab === 'api' && <ApiKeysTab />}
    </section>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-primary-600 text-primary-700'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
      }`}
    >
      {label}
    </button>
  );
}

function IntegrationsTab(): ReactElement {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(apiFetch),
  });
  const profile: ProfileResponse | null = profileQuery.data ?? null;
  const loadError = profileQuery.error ? (profileQuery.error as Error).message : null;

  const [brandName, setBrandName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [canonicalBaseUrl, setCanonicalBaseUrl] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [serviceAccount, setServiceAccount] = useState('');
  const [cruxKey, setCruxKey] = useState('');
  const [youtubeKey, setYoutubeKey] = useState('');

  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the editable fields whenever fresh profile data lands (initial load
  // and after a save writes the response into the cache).
  useEffect(() => {
    if (!profileQuery.data) return;
    setBrandName(profileQuery.data.brand.name ?? '');
    setWebsiteUrl(profileQuery.data.brand.website_url ?? '');
    setCanonicalBaseUrl(profileQuery.data.blog?.canonical_base_url ?? '');
    setPropertyId(profileQuery.data.ga4.property_id ?? '');
  }, [profileQuery.data]);

  const submit = async (): Promise<void> => {
    setSaveError(null);
    setSaved(false);

    const payload: ProfileUpdateRequest = {};
    if (brandName.trim()) payload.brand_name = brandName.trim();
    if (websiteUrl.trim()) payload.website_url = websiteUrl.trim();
    // Sent whenever it differs from what loaded, so clearing the field clears
    // the setting rather than silently leaving the old base in place.
    const storedBase = profile?.blog?.canonical_base_url ?? '';
    if (canonicalBaseUrl.trim() !== storedBase) {
      payload.blog = { canonical_base_url: canonicalBaseUrl.trim() || null };
    }
    if (propertyId.trim()) payload.ga4_property_id = propertyId.trim();
    if (serviceAccount.trim()) payload.ga4_service_account = serviceAccount.trim();
    if (cruxKey.trim()) payload.crux_api_key = cruxKey.trim();
    if (youtubeKey.trim()) payload.youtube_api_key = youtubeKey.trim();

    if (Object.keys(payload).length === 0) {
      setSaveError('Nothing to save. Fill in at least one field.');
      return;
    }

    setBusy(true);
    try {
      const res = await updateProfile(apiFetch, payload);
      // The seeding effect above re-fills brand/website/property from this.
      queryClient.setQueryData(['profile'], res);
      // Secrets are write-only — clear the inputs once stored.
      setServiceAccount('');
      setCruxKey('');
      setYoutubeKey('');
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="card card-body space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Brand</h2>
          <p className="text-sm text-muted-foreground">
            Shown at the top of every report you share with a sponsor.
          </p>
        </div>

        <label className="block">
          <span className="field-label">Brand name</span>
          <input
            type="text"
            className="input"
            placeholder="e.g. Ready, Set, Cloud!"
            value={brandName}
            maxLength={80}
            onChange={(e) => setBrandName(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="block">
          <span className="field-label">Website</span>
          <input
            type="text"
            className="input"
            placeholder="readysetcloud.io"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>

      <div className="card card-body space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Publishing</h2>
          <p className="text-sm text-muted-foreground">
            Where your content lives. Posts store their canonical link as a path, like{' '}
            <code>/blog/my-post/</code>. This turns that path into a full URL on the content
            page, and in the canonical sent to dev.to, Medium, and Hashnode when you cross-post.
            If you move domains, change it here. Nothing else needs updating.
          </p>
        </div>

        <label className="block">
          <span className="field-label">Canonical base URL</span>
          <input
            type="text"
            className="input"
            placeholder="https://readysetcloud.io"
            value={canonicalBaseUrl}
            onChange={(e) => setCanonicalBaseUrl(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>

      <p className="text-sm text-muted-foreground">
        Connect Google Analytics 4 and Core Web Vitals to pull per-post web analytics on each
        campaign. Credentials are stored encrypted and never shown again after saving.
      </p>

      {loadError && <p className="form-error">Could not load settings: {loadError}</p>}

      <div className="card card-body space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Google Analytics 4</h2>
          <StatusPill configured={profile?.ga4.configured ?? false} />
        </div>
        <p className="text-sm text-muted-foreground">
          GA4 uses a <span className="font-medium text-foreground">service account</span>, not an
          API key. Create one in Google Cloud, download its JSON key, and grant the service
          account <span className="font-medium text-foreground">Viewer</span> on your GA4 property.
          {profile?.ga4.service_account_email && (
            <>
              {' '}
              Current service account:{' '}
              <code className="bg-muted rounded px-1 py-0.5 text-xs">
                {profile.ga4.service_account_email}
              </code>
              .
            </>
          )}
        </p>

        <label className="block">
          <span className="field-label">GA4 property ID</span>
          <input
            type="text"
            className="input"
            placeholder="123456789"
            value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="block">
          <span className="field-label">
            Service account JSON {profile?.ga4.configured && '(paste again to replace)'}
          </span>
          <textarea
            className="input font-mono text-xs"
            rows={6}
            placeholder='{ "type": "service_account", "client_email": "...", "private_key": "..." }'
            value={serviceAccount}
            onChange={(e) => setServiceAccount(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>

      <div className="card card-body space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Core Web Vitals</h2>
          <StatusPill configured={profile?.core_web_vitals.configured ?? false} />
        </div>
        <p className="text-sm text-muted-foreground">
          A standard Google API key with the{' '}
          <span className="font-medium text-foreground">CrUX API</span> and{' '}
          <span className="font-medium text-foreground">PageSpeed Insights API</span> enabled. We
          use real-user CrUX data when available and fall back to a PageSpeed Insights lab run for
          newer or low-traffic posts.
        </p>

        <label className="block">
          <span className="field-label">
            API key {profile?.core_web_vitals.configured && '(enter again to replace)'}
          </span>
          <input
            type="password"
            className="input"
            placeholder="AIza..."
            value={cruxKey}
            onChange={(e) => setCruxKey(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>

      <div className="card card-body space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">YouTube</h2>
          <StatusPill configured={profile?.youtube.configured ?? false} />
        </div>
        <p className="text-sm text-muted-foreground">
          A standard Google API key with the{' '}
          <span className="font-medium text-foreground">YouTube Data API v3</span> enabled. Used to
          pull public views, likes, and comments on campaigns whose main deliverable is a YouTube
          video. This can be the same key as Core Web Vitals if you enable both APIs on it.
        </p>

        <label className="block">
          <span className="field-label">
            API key {profile?.youtube.configured && '(enter again to replace)'}
          </span>
          <input
            type="password"
            className="input"
            placeholder="AIza..."
            value={youtubeKey}
            onChange={(e) => setYoutubeKey(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>

      {saveError && <p className="form-error">{saveError}</p>}
      {saved && <p className="text-sm text-success-700">Settings saved.</p>}

      <div className="flex justify-end">
        <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving...' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}

function ExtensionTab(): ReactElement {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  const pairingsQuery = useQuery({
    queryKey: ['extension-pairings'],
    queryFn: async () => (await listExtensionPairings(apiFetch)).pairings,
  });
  const pairings: ExtensionPairing[] = pairingsQuery.data ?? [];
  const loading = pairingsQuery.isPending;
  const loadError = pairingsQuery.error ? (pairingsQuery.error as Error).message : null;

  const [generateOpen, setGenerateOpen] = useState(false);
  const [justMinted, setJustMinted] = useState<CreateExtensionPairingResponse | null>(null);

  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const onGenerated = (res: CreateExtensionPairingResponse): void => {
    queryClient.setQueryData<ExtensionPairing[]>(['extension-pairings'], (prev) => [
      ...(prev ?? []),
      res.pairing,
    ]);
    void queryClient.invalidateQueries({ queryKey: ['extension-pairings'] });
    setGenerateOpen(false);
    setJustMinted(res);
  };

  const revoke = async (jti: string): Promise<void> => {
    setRevokeError(null);
    setRevoking(jti);
    try {
      await revokeExtensionPairing(apiFetch, jti);
      queryClient.setQueryData<ExtensionPairing[]>(['extension-pairings'], (prev) =>
        (prev ?? []).filter((p) => p.jti !== jti),
      );
      void queryClient.invalidateQueries({ queryKey: ['extension-pairings'] });
    } catch (err) {
      setRevokeError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        The Booked Chrome extension reads engagement numbers off X, LinkedIn, and Instagram as
        you browse your tracked social posts and writes them back to Booked.
      </p>

      <div className="card card-body space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Install the extension</h2>
        <div>
          <a
            href="/booked-extension.zip"
            download="booked-extension.zip"
            className="btn btn-primary inline-flex"
          >
            Download extension (.zip)
          </a>
        </div>
        <ol className="list-decimal list-inside space-y-2 text-sm text-foreground">
          <li>Unzip the download anywhere on your machine.</li>
          <li>
            Open{' '}
            <code className="bg-muted rounded px-1.5 py-0.5 text-xs font-mono">
              chrome://extensions
            </code>{' '}
            in Chrome and turn on Developer mode (top right).
          </li>
          <li>
            Click <span className="font-medium">Load unpacked</span> and select the{' '}
            <code className="font-mono text-xs">booked-extension</code> folder you just
            unzipped.
          </li>
          <li>
            Under <span className="font-medium">Paired devices</span> below, click the{' '}
            <span className="font-medium">+</span> button to generate a pairing code.
          </li>
          <li>
            The extension in this browser pairs automatically — the dialog confirms it, and
            your tracked posts show up in the popup. To set up a different browser, paste the
            code into that browser's extension popup instead.
          </li>
        </ol>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Paired devices</h2>
          <button
            type="button"
            className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-primary-600 text-white hover:bg-primary-700 text-xl leading-none"
            onClick={() => setGenerateOpen(true)}
            aria-label="Generate a new pairing code"
            title="Generate a new pairing code"
          >
            +
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          Each browser running the Booked extension shows up here as a paired device. Generate
          a pairing code with <span className="font-medium">+</span> for each new browser, and
          revoke a row to cut that browser off — the pairing code is the only credential the
          extension holds for your account.
        </p>
        {loadError && <p className="form-error">Could not load pairings: {loadError}</p>}
        {revokeError && <p className="form-error">{revokeError}</p>}
        {loading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : pairings.length === 0 ? (
          <p className="text-muted-foreground">No paired devices yet.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Created</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pairings.map((p) => (
                <tr key={p.jti}>
                  <td>{p.label}</td>
                  <td className="text-muted-foreground">{p.created_at.slice(0, 10)}</td>
                  <td className="text-muted-foreground">
                    {p.last_used_at ? new Date(p.last_used_at).toLocaleString() : 'never'}
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="btn-link text-error-600"
                      onClick={() => void revoke(p.jti)}
                      disabled={revoking === p.jti}
                    >
                      {revoking === p.jti ? 'Revoking...' : 'Revoke'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <GeneratePairingDialog
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        onGenerated={onGenerated}
      />

      <NewPairingDialog
        result={justMinted}
        onClose={() => setJustMinted(null)}
      />
    </div>
  );
}

function GeneratePairingDialog({
  open,
  onClose,
  onGenerated,
}: {
  open: boolean;
  onClose: () => void;
  onGenerated: (res: CreateExtensionPairingResponse) => void;
}): ReactElement | null {
  const apiFetch = useApiFetch();
  const [label, setLabel] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setLabel('');
      setError(null);
      setGenerating(false);
    }
  }, [open]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    setError(null);
    setGenerating(true);
    try {
      const res = await createExtensionPairing(apiFetch, {
        label: label.trim() || undefined,
      });
      onGenerated(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Modal open title="Generate a new pairing code" onClose={onClose}>
      <div className="space-y-4 text-sm text-foreground">
        <p className="text-muted-foreground">
          A pairing code lets one browser's Booked extension talk to your account. Give it a
          label so you can tell devices apart later when you revoke one.
        </p>
        <label className="block">
          <span className="field-label">Label (optional)</span>
          <input
            type="text"
            className="input"
            placeholder="e.g. Allen's laptop"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            disabled={generating}
            autoFocus
          />
          <span className="field-hint">
            Shown only on this page so you can identify the device when revoking.
          </span>
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={generating}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={generating}
          >
            {generating ? 'Generating...' : 'Generate pairing code'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NewPairingDialog({
  result,
  onClose,
}: {
  result: CreateExtensionPairingResponse | null;
  onClose: () => void;
}): ReactElement | null {
  const [copied, setCopied] = useState(false);

  if (!result) return null;

  const copy = (): void => {
    void navigator.clipboard.writeText(result.token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Modal open title="Pairing code" onClose={onClose}>
      <div className="space-y-4 text-sm text-foreground">
        <p>
          If the Booked extension is installed in this browser, it pairs automatically — watch
          for a confirmation below. To pair a different browser, paste this code into that
          browser's extension popup. This is the only time the code will be shown; generate a
          new one if you lose it.
        </p>
        {/*
          Bridge for the Booked extension's dashboard content script. When the
          extension is installed here but not yet paired, it reads the token
          from this hidden slot and pairs automatically, reporting the outcome
          into the status slot. Both are inert when the extension isn't
          installed. The token is already shown in plaintext below, so the
          hidden attribute adds no exposure beyond what's on screen.
        */}
        <div
          data-booked-slot="pairing-token"
          data-booked-token={result.token}
          hidden
          aria-hidden="true"
        />
        <div className="space-y-2">
          <code className="block bg-muted rounded p-3 font-mono text-xs break-all">
            {result.token}
          </code>
          <div className="flex justify-end">
            <button type="button" className="btn btn-secondary" onClick={copy}>
              {copied ? 'Copied' : 'Copy to clipboard'}
            </button>
          </div>
          <p data-booked-slot="pairing-status" className="text-sm font-medium" hidden />
        </div>
        <p className="text-muted-foreground">
          Treat this code like a password. Anyone with it can read and update your campaign data.
          Revoke it from the Paired devices list if it leaks.
        </p>
        <div className="flex justify-end">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ApiKeysTab(): ReactElement {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  const keysQuery = useQuery({
    queryKey: ['api-keys'],
    queryFn: async () => (await listApiKeys(apiFetch)).keys,
  });
  const keys: ApiKey[] = keysQuery.data ?? [];
  const loading = keysQuery.isPending;
  const loadError = keysQuery.error ? (keysQuery.error as Error).message : null;

  const [generateOpen, setGenerateOpen] = useState(false);
  const [justMinted, setJustMinted] = useState<CreateApiKeyResponse | null>(null);

  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const onGenerated = (res: CreateApiKeyResponse): void => {
    const { key: _key, ...meta } = res;
    queryClient.setQueryData<ApiKey[]>(['api-keys'], (prev) => [...(prev ?? []), meta]);
    void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    setGenerateOpen(false);
    setJustMinted(res);
  };

  const revoke = async (jti: string): Promise<void> => {
    setRevokeError(null);
    setRevoking(jti);
    try {
      await revokeApiKey(apiFetch, jti);
      queryClient.setQueryData<ApiKey[]>(['api-keys'], (prev) =>
        (prev ?? []).filter((k) => k.jti !== jti),
      );
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      setRevokeError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        API keys let automation — like a GitHub Actions workflow in your writing repo — publish to
        Booked without a dashboard sign-in. Each key is a long-lived, revocable credential scoped
        to your account.
      </p>

      <div className="card card-body space-y-3 text-sm text-foreground">
        <h2 className="text-lg font-semibold text-foreground">What a key can do</h2>
        <p className="text-muted-foreground">
          API keys are accepted only on the content <span className="font-medium">publish</span>{' '}
          endpoints — creating a blog or content item, recording a publish, and cross-posting.
          Everything else (reading, editing, deleting, campaigns, revenue) still requires signing
          in here, so a leaked key can only ever add content.
        </p>
        <p className="text-muted-foreground">
          Send it as an <code className="bg-muted rounded px-1.5 py-0.5 text-xs font-mono">Authorization</code>{' '}
          header on your request, e.g.{' '}
          <code className="bg-muted rounded px-1.5 py-0.5 text-xs font-mono">
            Authorization: Bearer &lt;key&gt;
          </code>
          . Include an{' '}
          <code className="bg-muted rounded px-1.5 py-0.5 text-xs font-mono">Idempotency-Key</code>{' '}
          (your commit SHA works well) so a re-run won't create duplicates.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Your keys</h2>
          <button
            type="button"
            className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-primary-600 text-white hover:bg-primary-700 text-xl leading-none"
            onClick={() => setGenerateOpen(true)}
            aria-label="Create a new API key"
            title="Create a new API key"
          >
            +
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          Create one key per automation and give it a label so you can tell them apart. Revoke a
          row to cut that automation off immediately.
        </p>
        {loadError && <p className="form-error">Could not load keys: {loadError}</p>}
        {revokeError && <p className="form-error">{revokeError}</p>}
        {loading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : keys.length === 0 ? (
          <p className="text-muted-foreground">No API keys yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.jti}>
                    <td>{k.label}</td>
                    <td className="text-muted-foreground">{k.created_at.slice(0, 10)}</td>
                    <td className="text-muted-foreground">
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        className="btn-link text-error-600"
                        onClick={() => void revoke(k.jti)}
                        disabled={revoking === k.jti}
                      >
                        {revoking === k.jti ? 'Revoking...' : 'Revoke'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <GenerateApiKeyDialog
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        onGenerated={onGenerated}
      />

      <NewApiKeyDialog result={justMinted} onClose={() => setJustMinted(null)} />
    </div>
  );
}

function GenerateApiKeyDialog({
  open,
  onClose,
  onGenerated,
}: {
  open: boolean;
  onClose: () => void;
  onGenerated: (res: CreateApiKeyResponse) => void;
}): ReactElement | null {
  const apiFetch = useApiFetch();
  const [label, setLabel] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setLabel('');
      setError(null);
      setGenerating(false);
    }
  }, [open]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    setError(null);
    setGenerating(true);
    try {
      const res = await createApiKey(apiFetch, { label: label.trim() || undefined });
      onGenerated(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Modal open title="Create an API key" onClose={onClose}>
      <div className="space-y-4 text-sm text-foreground">
        <p className="text-muted-foreground">
          Give the key a label so you can tell your automations apart later when you revoke one.
        </p>
        <label className="block">
          <span className="field-label">Label (optional)</span>
          <input
            type="text"
            className="input"
            placeholder="e.g. writing-repo publish"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            disabled={generating}
            autoFocus
          />
          <span className="field-hint">Shown only on this page so you can identify it later.</span>
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={generating}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={generating}>
            {generating ? 'Creating...' : 'Create key'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NewApiKeyDialog({
  result,
  onClose,
}: {
  result: CreateApiKeyResponse | null;
  onClose: () => void;
}): ReactElement | null {
  const [copied, setCopied] = useState(false);

  if (!result) return null;

  const copy = (): void => {
    void navigator.clipboard.writeText(result.key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Modal open title="API key created" onClose={onClose}>
      <div className="space-y-4 text-sm text-foreground">
        <p>
          Store this key as a secret in your automation (e.g. a{' '}
          <code className="bg-muted rounded px-1.5 py-0.5 text-xs font-mono">BOOKED_API_KEY</code>{' '}
          repository secret). This is the only time it will be shown — create a new one if you lose
          it.
        </p>
        <div className="space-y-2">
          <code className="block bg-muted rounded p-3 font-mono text-xs break-all">
            {result.key}
          </code>
          <div className="flex justify-end">
            <button type="button" className="btn btn-secondary" onClick={copy}>
              {copied ? 'Copied' : 'Copy to clipboard'}
            </button>
          </div>
        </div>
        <p className="text-muted-foreground">
          Treat this key like a password. Anyone with it can publish content to your account.
          Revoke it from the keys list if it leaks.
        </p>
        <div className="flex justify-end">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

// What each platform calls its credential, and where to find it plus the ids.
// Kept to the facts the adapters rely on: dev.to needs only a key, Medium and
// Hashnode also need the publication posts go into.
const CROSSPOST_GUIDE: Record<
  CrosspostPlatform,
  { tokenLabel: string; tokenHelp: string; fields: { key: 'organization_id' | 'publication_id' | 'blog_url'; label: string; help: string; optional?: boolean }[]; note?: string }
> = {
  dev: {
    tokenLabel: 'API key',
    tokenHelp: 'Generate one on dev.to under Settings, then Extensions.',
    fields: [
      {
        key: 'organization_id',
        label: 'Organization ID',
        help: 'Only needed to publish under an organization. Leave blank to post as yourself.',
        optional: true,
      },
    ],
  },
  medium: {
    tokenLabel: 'Integration token',
    tokenHelp: 'Found on Medium under Settings, then Security and apps.',
    fields: [
      { key: 'publication_id', label: 'Publication ID', help: 'The publication cross-posts go into.' },
    ],
    note: 'Medium cross-posts arrive as drafts. You publish them from Medium.',
  },
  hashnode: {
    tokenLabel: 'Personal access token',
    tokenHelp: 'Generate one on Hashnode under Settings, then Developer.',
    fields: [
      { key: 'publication_id', label: 'Publication ID', help: 'Your blog’s ID, from its Hashnode dashboard.' },
      {
        key: 'blog_url',
        label: 'Blog URL',
        help: 'Used to build the post link if Hashnode doesn’t return one.',
        optional: true,
      },
    ],
  },
};

// Settings for "Cross-post for me": one card per platform. The content page's
// cross-post panel links straight to a card (#crosspost-<platform>) with
// `from` set, so after saving there's a one-click way back to the post.
function CrosspostTab(): ReactElement {
  const apiFetch = useApiFetch();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnPath(searchParams.get('from'));

  const query = useQuery({
    queryKey: CROSSPOST_SETTINGS_KEY,
    queryFn: () => getCrosspostSettings(apiFetch),
  });
  const loadError = query.error ? (query.error as Error).message : null;

  // Land on the card the content page sent us to. Runs once the cards exist;
  // the hash names a card id, so there is nothing to parse.
  useEffect(() => {
    if (!query.data || !location.hash) return;
    const card = document.getElementById(location.hash.slice(1));
    if (!card) return;
    card.scrollIntoView?.({ block: 'start' });
    card.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }, [query.data, location.hash]);

  return (
    <div className="space-y-6">
      {returnTo && (
        <Link to={returnTo} className="btn-link text-sm">← Back to your post</Link>
      )}

      <p className="text-sm text-muted-foreground">
        Connect a platform to cross-post from a post&apos;s page in one click. Tokens are stored
        encrypted and never shown again after saving. You can always add a link to a copy you
        posted yourself, with or without a connection.
      </p>

      {loadError && <p className="form-error">Could not load cross-posting settings: {loadError}</p>}
      {!query.data && !loadError && <p className="text-sm text-muted-foreground">Loading…</p>}

      {query.data &&
        CROSSPOST_PLATFORMS.map((platform) => (
          <CrosspostPlatformCard
            key={platform}
            platform={platform}
            readiness={query.data.platforms[platform]}
            returnTo={returnTo}
          />
        ))}
    </div>
  );
}

function CrosspostPlatformCard({
  platform,
  readiness,
  returnTo,
}: {
  platform: CrosspostPlatform;
  readiness: CrosspostPlatformReadiness;
  returnTo: string | null;
}): ReactElement {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const guide = CROSSPOST_GUIDE[platform];
  const label = CROSSPOST_PLATFORM_LABELS[platform];

  const storedField = (key: 'organization_id' | 'publication_id' | 'blog_url'): string => readiness[key] ?? '';

  const [token, setToken] = useState('');
  const [fields, setFields] = useState<Record<string, string>>(() =>
    Object.fromEntries(guide.fields.map((f) => [f.key, storedField(f.key)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  // Re-seed the id fields when a save (here or in another card) lands new data.
  useEffect(() => {
    setFields(Object.fromEntries(guide.fields.map((f) => [f.key, readiness[f.key] ?? ''])));
  }, [readiness, guide]);

  const send = async (update: CrosspostPlatformUpdate): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await updateCrosspostSettings(apiFetch, { platforms: { [platform]: update } });
      queryClient.setQueryData(CROSSPOST_SETTINGS_KEY, res);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    // Only what changed. A blank token means "keep the stored one", and an id
    // emptied out means clear it, so the payload never guesses.
    const update: CrosspostPlatformUpdate = {};
    if (token.trim()) update.token = token.trim();
    for (const f of guide.fields) {
      const next = (fields[f.key] ?? '').trim();
      if (next !== storedField(f.key)) update[f.key] = next || null;
    }
    if (Object.keys(update).length === 0) {
      setError(readiness.token_configured ? 'Nothing changed.' : `Paste your ${guide.tokenLabel.toLowerCase()} to connect.`);
      return;
    }
    if (await send(update)) {
      setToken(''); // write-only: never keep a secret in the form once stored
      setSaved(true);
    }
  };

  const disconnect = async (): Promise<void> => {
    setConfirmingDisconnect(false);
    // Clears the token only. The publication id stays so reconnecting later is
    // just pasting a new token.
    if (await send({ token: null })) setSaved(true);
  };

  const needs = readiness.missing
    .map((m) => (m === 'token' ? guide.tokenLabel.toLowerCase() : 'publication ID'))
    .join(' and ');

  return (
    <div id={`crosspost-${platform}`} className="card card-body space-y-4 scroll-mt-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">{label}</h2>
        {readiness.ready ? (
          <span className="status-pill status-active">Ready</span>
        ) : (
          <span className="status-pill status-draft">Needs {needs}</span>
        )}
      </div>

      <label className="block">
        <span className="field-label">
          {guide.tokenLabel} {readiness.token_configured && '(stored, enter a new one to replace)'}
        </span>
        <input
          type="password"
          className="input"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={readiness.token_configured ? '••••••••' : `Paste your ${guide.tokenLabel.toLowerCase()}`}
          disabled={busy}
        />
        <span className="text-xs text-muted-foreground">{guide.tokenHelp}</span>
      </label>

      {guide.fields.map((f) => (
        <label key={f.key} className="block">
          <span className="field-label">
            {f.label}
            {f.optional && <span className="text-muted-foreground font-normal"> (optional)</span>}
          </span>
          <input
            type="text"
            className="input"
            value={fields[f.key] ?? ''}
            onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
            disabled={busy}
          />
          <span className="text-xs text-muted-foreground">{f.help}</span>
        </label>
      ))}

      {guide.note && <p className="text-xs text-muted-foreground">{guide.note}</p>}

      {error && <p className="form-error">{error}</p>}
      {saved && !error && (
        <p className="text-sm text-success-700">
          {readiness.ready ? `${label} is ready to cross-post.` : 'Saved.'}
          {readiness.ready && returnTo && (
            <>
              {' '}
              <Link to={returnTo} className="btn-link">Back to your post</Link>
            </>
          )}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <div>
          {readiness.token_configured &&
            (confirmingDisconnect ? (
              <span className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Remove the stored {guide.tokenLabel.toLowerCase()}?</span>
                <button type="button" className="btn btn-error btn-sm" onClick={() => void disconnect()} disabled={busy}>
                  Disconnect
                </button>
                <button type="button" className="btn-link text-sm" onClick={() => setConfirmingDisconnect(false)} disabled={busy}>
                  Keep it
                </button>
              </span>
            ) : (
              <button type="button" className="btn-link text-sm" onClick={() => setConfirmingDisconnect(true)} disabled={busy}>
                Disconnect
              </button>
            ))}
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : `Save ${label}`}
        </button>
      </div>
    </div>
  );
}

function StatusPill({ configured }: { configured: boolean }): ReactElement {
  return configured ? (
    <span className="status-pill status-active">Connected</span>
  ) : (
    <span className="status-pill status-draft">Not connected</span>
  );
}
