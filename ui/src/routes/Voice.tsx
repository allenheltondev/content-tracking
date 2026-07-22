import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApiFetch } from '../auth/useApiFetch';
import { formatDate } from '../lib/format';
import {
  VOICE_PLATFORMS,
  checkVoice,
  deleteVoiceSample,
  getVoiceOverview,
  getVoiceProfile,
  listVoiceSamples,
  platformLabel,
  reflectVoiceProfile,
  setVoiceSampleMuted,
  setVoiceSteering,
} from '../api/voice';
import type {
  VoiceAssessment,
  VoiceFormat,
  VoiceOverviewEntry,
  VoiceProfile,
  VoiceReflection,
  VoiceSample,
} from '../api/types';

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}// "blog" is inherently long-form; everything else is short-form social.
function formatFor(platform: string): VoiceFormat {
  return platform === 'blog' ? 'blog' : 'social';
}

export default function Voice(): ReactElement {
  const apiFetch = useApiFetch();
  const [overview, setOverview] = useState<VoiceOverviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getVoiceOverview(apiFetch);
      setOverview(res.platforms);
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
        <h1 className="text-2xl font-semibold text-foreground">Your voice</h1>
        <p className="text-sm text-muted-foreground">
          A living model of how you write, learned from your published posts and weighted toward your
          most recent work. Use it to draft in your voice, and check whether anything already sounds like you.
        </p>
      </header>

      <VoiceChecker knownPlatforms={overview.map((o) => o.platform)} />

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : overview.length === 0 ? (
        <div className="card card-body text-center text-muted-foreground py-10">
          <p className="text-foreground font-medium">No voice learned yet</p>
          <p className="text-sm mt-1">
            Publish a blog post or save posts on the Compose page. Your voice profile appears here
            once a platform has samples to learn from.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {overview.map((entry) => (
            <OverviewCard
              key={entry.platform}
              entry={entry}
              expanded={selected === entry.platform}
              onToggle={() => setSelected(selected === entry.platform ? null : entry.platform)}
            />
          ))}
        </div>
      )}

      {selected && <ProfileDetail key={selected} platform={selected} onChanged={load} />}
    </section>
  );
}

// The plain-English portrait + corpus transparency for one platform. This is the
// flagship at-a-glance view: what the voice sounds like, and what it's listening to.
function OverviewCard({
  entry,
  expanded,
  onToggle,
}: {
  entry: VoiceOverviewEntry;
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  const { corpus } = entry;
  // The widest horizon whose window covers a majority of the current voice is
  // the most intuitive headline ("the last 90 days are 71% of your voice").
  const headline = corpus.recent_influence.find((h) => h.influence_share >= 0.5)
    ?? corpus.recent_influence[corpus.recent_influence.length - 1];

  return (
    <div className="card card-body space-y-3">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left flex items-start justify-between gap-3"
        aria-expanded={expanded}
      >
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">{platformLabel(entry.platform)}</span>
            <span className="text-xs text-muted-foreground">
              {entry.version > 0 ? `v${entry.version}` : 'learning'}
            </span>
          </div>
          {entry.portrait ? (
            <p className="text-sm text-foreground">{entry.portrait}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Portrait pending — refresh once a few posts are in.
            </p>
          )}
          {entry.steering && (
            <p className="text-xs text-muted-foreground">Steering toward: “{entry.steering}”</p>
          )}
        </div>
        <span className="text-muted-foreground text-sm shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground border-t border-border pt-2">
        <span>
          <span className="font-medium text-foreground">{corpus.total_samples}</span>{' '}
          {corpus.total_samples === 1 ? 'sample' : 'samples'}
        </span>
        {corpus.earliest_published && corpus.latest_published && (
          <span>{formatDate(corpus.earliest_published)} – {formatDate(corpus.latest_published)}</span>
        )}
        {Object.entries(corpus.by_source).map(([src, n]) => (
          <span key={src}>{SOURCE_LABEL[src] ?? src} ×{n}</span>
        ))}
        {(corpus.excluded.muted > 0 || corpus.excluded.generated > 0) && (
          <span className="italic">
            held out:
            {corpus.excluded.muted > 0 ? ` ${corpus.excluded.muted} muted` : ''}
            {corpus.excluded.generated > 0 ? ` ${corpus.excluded.generated} generated` : ''}
          </span>
        )}
      </div>

      {headline && headline.sample_count > 0 && (
        <div className="space-y-1">
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary-500"
              style={{ width: `${Math.round(headline.influence_share * 100)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Posts from the last {headline.window_days} days shape{' '}
            <span className="font-medium text-foreground">{Math.round(headline.influence_share * 100)}%</span>{' '}
            of your current voice (half-life {entry.recency_half_life_days} days).
          </p>
        </div>
      )}
    </div>
  );
}

// Paste-and-score: how on-voice is this draft? Uses the same retrieval as
// compose, but grades instead of writing.
function VoiceChecker({ knownPlatforms }: { knownPlatforms: string[] }): ReactElement {
  const apiFetch = useApiFetch();
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<string>(knownPlatforms[0] ?? 'blog');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VoiceAssessment | null>(null);

  // Default the platform selector to one the creator actually has a voice for.
  useEffect(() => {
    if (knownPlatforms.length > 0 && !knownPlatforms.includes(platform)) {
      setPlatform(knownPlatforms[0]);
    }
  }, [knownPlatforms, platform]);

  const check = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await checkVoice(apiFetch, { draft: draft.trim(), platform, format: formatFor(platform) });
      setResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Check a draft against your voice
      </button>
    );
  }

  return (
    <div className="card card-body space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Does this sound like you?</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Close</button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="field-label">Platform</span>
          <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value)} disabled={busy}>
            {VOICE_PLATFORMS.map((p) => (
              <option key={p} value={p}>{platformLabel(p)}</option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        className="input min-h-[8rem]"
        placeholder="Paste a draft to score it against your learned voice…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={busy}
      />
      {error && <p className="form-error">{error}</p>}
      <div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void check()} disabled={busy || draft.trim().length === 0}>
          {busy ? 'Scoring…' : 'Check voice match'}
        </button>
      </div>
      {result && <AssessmentView result={result} />}
    </div>
  );
}

const VERDICT_LABEL: Record<VoiceAssessment['verdict'], string> = {
  on_voice: 'On voice',
  close: 'Close',
  off_voice: 'Off voice',
};
function scoreTone(score: number): string {
  if (score >= 80) return 'text-success-700';
  if (score >= 50) return 'text-warning-700';
  return 'text-error-600';
}

function AssessmentView({ result }: { result: VoiceAssessment }): ReactElement {
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex items-center gap-3">
        <span className={`text-3xl font-bold ${scoreTone(result.score)}`}>{result.score}</span>
        <div>
          <span className={`text-sm font-medium ${scoreTone(result.score)}`}>{VERDICT_LABEL[result.verdict]}</span>
          <p className="text-sm text-foreground">{result.summary}</p>
        </div>
      </div>

      {result.strengths.length > 0 && (
        <div>
          <span className="field-label">What's working</span>
          <ul className="space-y-1">
            {result.strengths.map((s) => (
              <li key={s} className="text-sm text-foreground"><span className="text-success-700">✓</span> {s}</li>
            ))}
          </ul>
        </div>
      )}

      {result.issues.length > 0 && (
        <div>
          <span className="field-label">Where it drifts</span>
          <ul className="space-y-2">
            {result.issues.map((issue) => (
              <li key={issue.detail} className="text-sm">
                {issue.area && (
                  <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-foreground mr-1.5">
                    {issue.area}
                  </span>
                )}
                <span className="text-foreground">{issue.detail}</span>
                <span className="text-muted-foreground"> — {issue.suggestion}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.on_voice_rewrite && (
        <div>
          <span className="field-label">Rewritten in your voice</span>
          <p className="text-sm text-foreground bg-muted rounded-md p-3 whitespace-pre-wrap">{result.on_voice_rewrite}</p>
        </div>
      )}
    </div>
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
  const portrait = useMemo(() => asString(profile?.portrait) ?? asString(profile?.profile?.portrait), [profile]);

  return (
    <div className="card card-body space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">{platformLabel(platform)} voice</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={reflecting}>
          {reflecting ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <>
          {portrait && (
            <p className="text-sm text-foreground bg-muted/60 rounded-md p-3">{portrait}</p>
          )}

          <SteeringEditor
            platform={platform}
            current={profile?.steering ?? null}
            onSaved={async () => { await load(); onChanged(); }}
          />

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
              <h3 className="field-label">Your voice over time</h3>
              <ol className="space-y-3">
                {reflections.map((r) => (
                  <li key={r.reflection_id} className="text-sm border-l-2 border-border pl-3">
                    <div className="text-xs text-muted-foreground">
                      {r.version != null ? `v${r.version}` : 'update'} · {formatDate(r.created_at)}
                    </div>
                    {r.portrait && <p className="text-foreground mt-0.5">{r.portrait}</p>}
                    {r.change_summary && <p className="text-muted-foreground mt-0.5">{r.change_summary}</p>}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <SamplesList platform={platform} onDeleted={async () => { await load(); onChanged(); }} />
        </>
      )}
    </div>
  );
}

// The steering note: the creator's stated intent, which biases the next
// reflection. Saving it re-derives the profile server-side immediately.
function SteeringEditor({
  platform,
  current,
  onSaved,
}: {
  platform: string;
  current: string | null;
  onSaved: () => Promise<void>;
}): ReactElement {
  const apiFetch = useApiFetch();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setNote(current ?? ''); }, [current]);

  const save = async (value: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setVoiceSteering(apiFetch, platform, value);
      setEditing(false);
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="field-label">Steering your voice</span>
          <button type="button" className="btn-link text-xs" onClick={() => setEditing(true)}>
            {current ? 'Edit' : 'Add a note'}
          </button>
        </div>
        {current ? (
          <p className="text-sm text-foreground">“{current}”</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Tell the model where you're taking your voice (e.g. “more concise, less hedging”). It biases the next refresh.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <span className="field-label">Steering your voice</span>
      <input
        className="input"
        placeholder="e.g. more concise, warmer, fewer bullet lists"
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
      />
      {error && <p className="form-error">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void save(note.trim() ? note.trim() : null)}
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Save & refresh voice'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditing(false); setNote(current ?? ''); }} disabled={busy}>
          Cancel
        </button>
        {current && (
          <button type="button" className="btn btn-ghost btn-sm text-error-600" onClick={() => void save(null)} disabled={busy}>
            Clear
          </button>
        )}
      </div>
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
  'content-auto': 'from published content',
};

// The memories that drive the voice. Each shows its current influence, and can
// be muted (excluded from the voice, reversibly) or — for pasted samples that
// won't re-capture — removed outright. Muting a published post is durable.
function SamplesList({ platform, onDeleted }: { platform: string; onDeleted: () => void }): ReactElement {
  const apiFetch = useApiFetch();
  const [samples, setSamples] = useState<VoiceSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const toggleMute = async (s: VoiceSample): Promise<void> => {
    setBusyId(s.sample_id);
    setError(null);
    try {
      await setVoiceSampleMuted(apiFetch, s.sample_id, platform, !s.muted);
      await load();
      onDeleted(); // curation re-derives the profile server-side; refresh the view
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      await deleteVoiceSample(apiFetch, id, platform);
      setSamples((prev) => prev.filter((s) => s.sample_id !== id));
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <h3 className="field-label">Memories driving this voice ({samples.length})</h3>
      <p className="text-xs text-muted-foreground">
        Each memory's share is how much it shapes your current voice right now (recency-weighted).
        Mute one to keep it out; muting a published post sticks even if you edit it later.
      </p>
      {error && <p className="form-error">{error}</p>}
      {loading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : samples.length === 0 ? (
        <p className="text-sm text-muted-foreground">No samples yet for this platform.</p>
      ) : (
        <ul className="space-y-2">
          {samples.map((s) => {
            const pct = s.influence_share != null ? Math.round(s.influence_share * 100) : null;
            const isAuto = s.source === 'content-auto';
            return (
              <li
                key={s.sample_id}
                className={`flex items-start justify-between gap-3 rounded-md p-2 ${s.muted ? 'bg-muted/30 opacity-60' : 'bg-muted/60'}`}
              >
                <div className="min-w-0">
                  <p className="text-sm text-foreground line-clamp-2">{s.text}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {SOURCE_LABEL[s.source ?? ''] ?? s.source ?? 'sample'}
                    {' · '}{s.published_at ? `published ${formatDate(s.published_at)}` : formatDate(s.created_at)}
                    {' · '}
                    {s.muted
                      ? <span className="text-muted-foreground">muted</span>
                      : <span className="text-foreground">{pct != null ? `${pct}% of your voice` : 'no influence'}</span>}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void toggleMute(s)}
                    disabled={busyId === s.sample_id}
                  >
                    {busyId === s.sample_id ? '…' : s.muted ? 'Unmute' : 'Mute'}
                  </button>
                  {!isAuto && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void remove(s.sample_id)}
                      disabled={busyId === s.sample_id}
                      aria-label="Delete sample"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
