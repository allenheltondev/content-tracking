import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import { getProfile, updateProfile } from '../api/profile';
import {
  createExtensionPairing,
  listExtensionPairings,
  revokeExtensionPairing,
} from '../api/extensions';
import type {
  CreateExtensionPairingResponse,
  ExtensionPairing,
  ProfileResponse,
  ProfileUpdateRequest,
} from '../api/types';
import Modal from '../components/Modal';

type SettingsTab = 'integrations' | 'extension';

const TAB_PARAM = 'tab';

function parseTab(value: string | null): SettingsTab {
  if (value === 'extension') return 'extension';
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
          label="Extension"
          active={activeTab === 'extension'}
          onClick={() => selectTab('extension')}
        />
      </nav>

      {activeTab === 'integrations' && <IntegrationsTab />}
      {activeTab === 'extension' && <ExtensionTab />}
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

  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [brandName, setBrandName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [serviceAccount, setServiceAccount] = useState('');
  const [cruxKey, setCruxKey] = useState('');
  const [youtubeKey, setYoutubeKey] = useState('');

  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoadError(null);
    getProfile(apiFetch)
      .then((res) => {
        if (cancelled) return;
        setProfile(res);
        setBrandName(res.brand.name ?? '');
        setWebsiteUrl(res.brand.website_url ?? '');
        setPropertyId(res.ga4.property_id ?? '');
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  useEffect(() => load(), [load]);

  const submit = async (): Promise<void> => {
    setSaveError(null);
    setSaved(false);

    const payload: ProfileUpdateRequest = {};
    if (brandName.trim()) payload.brand_name = brandName.trim();
    if (websiteUrl.trim()) payload.website_url = websiteUrl.trim();
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
      setProfile(res);
      setBrandName(res.brand.name ?? '');
      setWebsiteUrl(res.brand.website_url ?? '');
      setPropertyId(res.ga4.property_id ?? '');
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
        <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving...' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}

function ExtensionTab(): ReactElement {
  const apiFetch = useApiFetch();

  const [pairings, setPairings] = useState<ExtensionPairing[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [generateOpen, setGenerateOpen] = useState(false);
  const [justMinted, setJustMinted] = useState<CreateExtensionPairingResponse | null>(null);

  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    setLoading(true);
    try {
      const res = await listExtensionPairings(apiFetch);
      setPairings(res.pairings);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const onGenerated = (res: CreateExtensionPairingResponse): void => {
    setPairings((prev) => [...prev, res.pairing]);
    setGenerateOpen(false);
    setJustMinted(res);
  };

  const revoke = async (jti: string): Promise<void> => {
    setRevokeError(null);
    setRevoking(jti);
    try {
      await revokeExtensionPairing(apiFetch, jti);
      setPairings((prev) => prev.filter((p) => p.jti !== jti));
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
            className="btn-primary inline-flex"
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
            <span className="font-medium">+</span> button to generate a pairing code and copy
            it from the dialog.
          </li>
          <li>
            Open the extension popup, paste the code into the{' '}
            <span className="font-medium">Pairing code</span> field, and click{' '}
            <span className="font-medium">Pair extension</span>. Your tracked posts show up
            in the popup once the pairing finishes.
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
            className="btn-secondary"
            onClick={onClose}
            disabled={generating}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
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
          Paste this code into the Booked Chrome extension's Options page. This is the only time
          it will be shown. Generate a new code if you lose it.
        </p>
        <div className="space-y-2">
          <code className="block bg-muted rounded p-3 font-mono text-xs break-all">
            {result.token}
          </code>
          <div className="flex justify-end">
            <button type="button" className="btn-secondary" onClick={copy}>
              {copied ? 'Copied' : 'Copy to clipboard'}
            </button>
          </div>
        </div>
        <p className="text-muted-foreground">
          Treat this code like a password. Anyone with it can read and update your campaign data.
          Revoke it from the Paired devices list if it leaks.
        </p>
        <div className="flex justify-end">
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

function StatusPill({ configured }: { configured: boolean }): ReactElement {
  return configured ? (
    <span className="status-pill status-active">Connected</span>
  ) : (
    <span className="status-pill status-draft">Not connected</span>
  );
}
