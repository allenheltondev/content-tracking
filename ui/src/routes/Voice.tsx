import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useApiFetch } from '../auth/useApiFetch';
import {
  deleteVoiceSample,
  getVoiceProfile,
  listVoiceProfiles,
  listVoiceSamples,
  platformLabel,
  reflectVoiceProfile,
} from '../api/voice';
import type { VoiceProfile, VoiceReflection, VoiceSample } from '../api/types';

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}
function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export default function Voice(): ReactElement {
  const apiFetch = useApiFetch();
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listVoiceProfiles(apiFetch);
      setProfiles(res.profiles);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">Your voice profiles</h1>
        <p className="text-sm text-muted-foreground">
          What the model has learned about how you write, per platform. Profiles refresh
          automatically as you save posts, or you can refresh one on demand.
        </p>
      </header>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : profiles.length === 0 ? (
        <div className="card card-body text-center text-muted-foreground py-10">
          <p className="text-foreground font-medium">No voice profiles yet</p>
          <p className="text-sm mt-1">
            Save or compose posts on the Compose page (or seed from your blog catalog). A profile
            appears here once a platform has samples.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {profiles.map((p) => (
            <button
              key={p.platform}
              type="button"
              onClick={() => setSelected(selected === p.platform ? null : p.platform)}
              className="card card-body w-full text-left flex items-center justify-between gap-3 hover:bg-muted transition-colors"
              aria-expanded={selected === p.platform}
            >
              <span className="font-medium text-foreground">{platformLabel(p.platform)}</span>
              <span className="text-xs text-muted-foreground">
                {p.version > 0 ? `v${p.version}` : 'learning'} · {p.samples_since_reflection} new since refresh
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && <ProfileDetail key={selected} platform={selected} onChanged={load} />}
    </section>
  );
}

function ProfileDetail({ platform, onChanged }: { platform: string; onChanged: () => void }): ReactElement {
  const apiFetch = useApiFetch();
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [reflections, setReflections] = useState<VoiceReflection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reflecting, setReflecting] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getVoiceProfile(apiFetch, platform);
      setProfile(res.profile);
      setReflections(res.reflections);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, platform]);

  useEffect(() => { void load(); }, [load]);

  const refresh = async (): Promise<void> => {
    setReflecting(true);
    setError(null);
    try {
      await reflectVoiceProfile(apiFetch, platform);
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReflecting(false);
    }
  };

  const since = profile?.samples_since_reflection ?? 0;
  const threshold = profile?.reflection_threshold ?? 0;
  const pct = threshold > 0 ? Math.min(100, Math.round((since / threshold) * 100)) : 0;

  return (
    <div className="card card-body space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">{platformLabel(platform)} voice</h2>
        <button type="button" className="btn-secondary btn-sm" onClick={() => void refresh()} disabled={reflecting}>
          {reflecting ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <>
          {threshold > 0 && (
            <div className="space-y-1">
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">
                {since === 0
                  ? 'Up to date — the profile reflects your latest saved posts.'
                  : `${since} of ${threshold} new posts until the next automatic refresh.`}
              </p>
            </div>
          )}

          {profile?.profile ? (
            <>
              <ProfileView profile={profile.profile} />
              <button type="button" className="btn-link text-xs" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? 'Hide raw JSON' : 'View raw JSON'}
              </button>
              {showRaw && (
                <pre className="text-xs text-foreground bg-muted rounded-md p-3 overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(profile.profile, null, 2)}
                </pre>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No learned profile yet — save a few posts for this platform, then refresh.
            </p>
          )}

          {reflections.length > 0 && (
            <div className="space-y-2 border-t border-border pt-3">
              <h3 className="field-label">Recent refreshes</h3>
              <ul className="space-y-2">
                {reflections.map((r) => (
                  <li key={r.reflection_id} className="text-sm">
                    <span className="text-foreground">{r.change_summary ?? '—'}</span>
                    <span className="text-muted-foreground"> · {fmtDate(r.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <SamplesList platform={platform} onDeleted={load} />
        </>
      )}
    </div>
  );
}

function ProfileView({ profile }: { profile: Record<string, unknown> }): ReactElement {
  const rows: { label: string; value: string }[] = [
    { label: 'Tone', value: asString(profile.tone) ?? '' },
    { label: 'Audience', value: asString(profile.audience) ?? '' },
    { label: 'Sentence structure', value: asString(profile.sentence_structure) ?? '' },
    { label: 'Vocabulary', value: asString(profile.vocabulary) ?? '' },
    { label: 'Formatting', value: asString(profile.formatting_preferences) ?? '' },
  ].filter((r) => r.value);

  const phrases = asStringArray(profile.signature_phrases);
  const dos = asStringArray(profile.dos);
  const donts = asStringArray(profile.donts);

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.label}>
          <span className="field-label">{r.label}</span>
          <p className="text-sm text-foreground">{r.value}</p>
        </div>
      ))}

      {phrases.length > 0 && (
        <div>
          <span className="field-label">Signature phrases</span>
          <div className="flex flex-wrap gap-1.5">
            {phrases.map((p) => (
              <span key={p} className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                {p}
              </span>
            ))}
          </div>
        </div>
      )}

      {(dos.length > 0 || donts.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {dos.length > 0 && (
            <div>
              <span className="field-label">Do</span>
              <ul className="space-y-1">
                {dos.map((d) => (
                  <li key={d} className="text-sm text-foreground"><span className="text-success-700">✓</span> {d}</li>
                ))}
              </ul>
            </div>
          )}
          {donts.length > 0 && (
            <div>
              <span className="field-label">Don't</span>
              <ul className="space-y-1">
                {donts.map((d) => (
                  <li key={d} className="text-sm text-foreground"><span className="text-error-600">✕</span> {d}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  generated: 'generated',
  manual: 'pasted',
  'blog-seed': 'from blog',
};

// The corpus the voice learns from — curate it by removing off-voice samples.
function SamplesList({ platform, onDeleted }: { platform: string; onDeleted: () => void }): ReactElement {
  const apiFetch = useApiFetch();
  const [samples, setSamples] = useState<VoiceSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listVoiceSamples(apiFetch, platform);
      setSamples(res.samples);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, platform]);

  useEffect(() => { void load(); }, [load]);

  const remove = async (id: string): Promise<void> => {
    setDeletingId(id);
    setError(null);
    try {
      await deleteVoiceSample(apiFetch, id, platform);
      setSamples((prev) => prev.filter((s) => s.sample_id !== id));
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <h3 className="field-label">Samples it learns from ({samples.length})</h3>
      {error && <p className="form-error">{error}</p>}
      {loading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : samples.length === 0 ? (
        <p className="text-sm text-muted-foreground">No samples yet for this platform.</p>
      ) : (
        <ul className="space-y-2">
          {samples.map((s) => (
            <li key={s.sample_id} className="flex items-start justify-between gap-3 rounded-md bg-muted/60 p-2">
              <div className="min-w-0">
                <p className="text-sm text-foreground line-clamp-2">{s.text}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {SOURCE_LABEL[s.source ?? ''] ?? s.source ?? 'sample'} · {fmtDate(s.created_at)}
                </p>
              </div>
              <button
                type="button"
                className="btn-ghost btn-sm shrink-0"
                onClick={() => void remove(s.sample_id)}
                disabled={deletingId === s.sample_id}
                aria-label="Delete sample"
              >
                {deletingId === s.sample_id ? '…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
