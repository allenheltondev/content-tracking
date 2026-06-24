import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useApiFetch } from '../auth/useApiFetch';
import { getVoiceProfile, listVoiceProfiles, reflectVoiceProfile } from '../api/voice';
import type { VoiceProfile, VoiceReflection } from '../api/types';

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
            appears here once a platform has enough samples.
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
              <span className="font-medium text-foreground capitalize">{p.platform}</span>
              <span className="text-xs text-muted-foreground">
                v{p.version} · {p.samples_since_reflection} new since refresh
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

  return (
    <div className="card card-body space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground capitalize">{platform} voice</h2>
        <button type="button" className="btn-secondary btn-sm" onClick={() => void refresh()} disabled={reflecting}>
          {reflecting ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <>
          {profile?.profile ? (
            <pre className="text-xs text-foreground bg-muted rounded-md p-3 overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(profile.profile, null, 2)}
            </pre>
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
                    <span className="text-muted-foreground"> · {r.created_at}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
