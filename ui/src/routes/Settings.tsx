import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import { getProfile, updateProfile } from '../api/profile';
import type { ProfileResponse, ProfileUpdateRequest } from '../api/types';

export default function Settings(): ReactElement {
  const apiFetch = useApiFetch();

  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [propertyId, setPropertyId] = useState('');
  const [serviceAccount, setServiceAccount] = useState('');
  const [cruxKey, setCruxKey] = useState('');

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
    if (propertyId.trim()) payload.ga4_property_id = propertyId.trim();
    if (serviceAccount.trim()) payload.ga4_service_account = serviceAccount.trim();
    if (cruxKey.trim()) payload.crux_api_key = cruxKey.trim();

    if (Object.keys(payload).length === 0) {
      setSaveError('Nothing to save. Fill in at least one field.');
      return;
    }

    setBusy(true);
    try {
      const res = await updateProfile(apiFetch, payload);
      setProfile(res);
      setPropertyId(res.ga4.property_id ?? '');
      // Secrets are write-only — clear the inputs once stored.
      setServiceAccount('');
      setCruxKey('');
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6 max-w-2xl">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Connect Google Analytics 4 and Core Web Vitals to pull per-post web analytics on each
          campaign. Credentials are stored encrypted and never shown again after saving.
        </p>
      </header>

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

      {saveError && <p className="form-error">{saveError}</p>}
      {saved && <p className="text-sm text-success-700">Settings saved.</p>}

      <div className="flex justify-end">
        <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving...' : 'Save settings'}
        </button>
      </div>
    </section>
  );
}

function StatusPill({ configured }: { configured: boolean }): ReactElement {
  return configured ? (
    <span className="status-pill status-active">Connected</span>
  ) : (
    <span className="status-pill status-draft">Not connected</span>
  );
}
