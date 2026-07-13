// Recency weighting for the Voice feature: the model of "your voice is what
// you sound like NOW". Every voice sample carries a publishedAt timestamp (the
// source post's publish date, falling back to capture time), and its influence
// decays exponentially with age:
//
//   weight = 0.5 ^ (ageInDays / halfLifeDays)
//
// Exponential decay is the standard recency model (it's the continuous form of
// an exponentially-weighted moving average): a post one half-life old counts
// half as much as one published today, two half-lives old a quarter, and so on.
// The half-life is the single tuning knob (VOICE_HALF_LIFE_DAYS, default 90),
// so "how fast does my voice move on" is an explicit, per-deployment decision.
//
// Two consumers:
//   - Reflection (voice-memory.mjs) selects the newest-by-publish-date window
//     from a candidate pool and hands the model normalized weight shares, so
//     the learned profile is biased toward the recent corpus.
//   - Compose (routes/voice.mjs, functions/stream-generate) re-ranks retrieved
//     few-shot examples by a blend of topical similarity and recency, so
//     synthesis leans on the current voice rather than the historical one.

const MS_PER_DAY = 86_400_000;

// A sample with no parseable date can't be placed on the decay curve; treat it
// as one half-life old (weight 0.5) so it neither dominates fresh samples nor
// vanishes entirely.
const UNKNOWN_DATE_WEIGHT = 0.5;

// How much recency matters vs topical similarity when ranking compose examples.
// 0 = pure similarity (the old behavior), 1 = pure recency.
const DEFAULT_RECENCY_BLEND = 0.35;

// How many candidates compose retrieves from the vector index before the
// recency re-rank, and how many survive it as few-shot examples.
export const COMPOSE_CANDIDATE_POOL = 16;
export const COMPOSE_EXAMPLE_COUNT = 5;

export function voiceHalfLifeDays() {
  const configured = Number(process.env.VOICE_HALF_LIFE_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : 90;
}

export function voiceRecencyBlend() {
  const configured = Number(process.env.VOICE_RECENCY_BLEND);
  return Number.isFinite(configured) && configured >= 0 && configured <= 1
    ? configured
    : DEFAULT_RECENCY_BLEND;
}

// The date a sample's voice was "current": publish date when known, capture
// time otherwise.
export function effectiveSampleDate(sample) {
  return sample?.publishedAt ?? sample?.createdAt ?? null;
}

// Exponential decay weight in (0, 1]. Future-dated samples (scheduled posts)
// clamp to 1 — they're the freshest signal we have, not an extrapolation.
export function recencyWeight(dateIso, { now = Date.now(), halfLifeDays = voiceHalfLifeDays() } = {}) {
  const timestamp = typeof dateIso === "string" ? Date.parse(dateIso) : NaN;
  if (Number.isNaN(timestamp)) return UNKNOWN_DATE_WEIGHT;
  const ageDays = Math.max(0, (now - timestamp) / MS_PER_DAY);
  return 0.5 ** (ageDays / halfLifeDays);
}

// Reflection window selection: weight every candidate by publish-date recency,
// keep the `limit` heaviest (i.e. newest), and normalize their weights into
// shares that sum to 1 so the reflection prompt can state each sample's
// influence explicitly. Returns [{ ...sample, recencyWeight, weightShare }]
// ordered heaviest-first.
export function selectRecencyWeighted(samples, { limit, now = Date.now(), halfLifeDays = voiceHalfLifeDays() } = {}) {
  const weighted = (samples ?? [])
    .map((s) => ({ ...s, recencyWeight: recencyWeight(effectiveSampleDate(s), { now, halfLifeDays }) }))
    .sort((a, b) => b.recencyWeight - a.recencyWeight);

  const window = typeof limit === "number" ? weighted.slice(0, limit) : weighted;
  const total = window.reduce((acc, s) => acc + s.recencyWeight, 0);
  return window.map((s) => ({
    ...s,
    weightShare: total > 0 ? s.recencyWeight / total : 0,
  }));
}

// Corpus transparency: summarizes the sample set a voice is learned from, and
// makes the recency math legible. Returns totals, a by-source breakdown, the
// published date range, and "influence horizons" — for each window (e.g. last
// 30/90/365 days), the share of the CURRENT voice that comes from posts inside
// it, computed as that window's recency weight over the whole corpus's. This is
// what lets the UI say "posts from the last 90 days shape 71% of your voice".
const DEFAULT_INFLUENCE_HORIZONS = [30, 90, 365];

export function summarizeVoiceCorpus(samples, {
  now = Date.now(),
  halfLifeDays = voiceHalfLifeDays(),
  horizons = DEFAULT_INFLUENCE_HORIZONS,
} = {}) {
  const list = samples ?? [];
  const total = list.length;

  const bySource = {};
  let earliest = null;
  let latest = null;
  let totalWeight = 0;
  const dated = [];

  for (const s of list) {
    const source = s.source ?? "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;

    const date = effectiveSampleDate(s);
    const ts = typeof date === "string" ? Date.parse(date) : NaN;
    if (!Number.isNaN(ts)) {
      if (earliest === null || ts < earliest) earliest = ts;
      if (latest === null || ts > latest) latest = ts;
      dated.push(ts);
    }
    totalWeight += recencyWeight(date, { now, halfLifeDays });
  }

  const recentInfluence = horizons.map((windowDays) => {
    const cutoff = now - windowDays * MS_PER_DAY;
    let windowWeight = 0;
    let count = 0;
    for (const s of list) {
      const date = effectiveSampleDate(s);
      const ts = typeof date === "string" ? Date.parse(date) : NaN;
      // Undated samples can't be placed in a window; they only affect the
      // denominator (via totalWeight), never a window's numerator.
      if (Number.isNaN(ts) || ts < cutoff) continue;
      windowWeight += recencyWeight(date, { now, halfLifeDays });
      count += 1;
    }
    return {
      windowDays,
      share: totalWeight > 0 ? windowWeight / totalWeight : 0,
      sampleCount: count,
    };
  });

  return {
    total,
    bySource,
    earliestPublished: earliest === null ? null : new Date(earliest).toISOString(),
    latestPublished: latest === null ? null : new Date(latest).toISOString(),
    halfLifeDays,
    recentInfluence,
  };
}

// Compose ranking: blends topical similarity (from the vector query's cosine
// distance) with publish-date recency, so the few-shot examples are both
// on-topic AND representative of the current voice. Candidates come from
// queryVoiceSamples ({ distance, publishedAt, ... }); cosine distance is
// 1 - cosineSimilarity, so similarity = 1 - distance, clamped to [0, 1].
export function rankVoiceSamples(candidates, {
  topK = COMPOSE_EXAMPLE_COUNT,
  now = Date.now(),
  halfLifeDays = voiceHalfLifeDays(),
  blend = voiceRecencyBlend(),
} = {}) {
  const scored = (candidates ?? []).map((c) => {
    const similarity = typeof c.distance === "number"
      ? Math.min(1, Math.max(0, 1 - c.distance))
      : 0.5;
    const recency = recencyWeight(c.publishedAt, { now, halfLifeDays });
    return {
      ...c,
      similarity,
      recencyWeight: recency,
      score: (1 - blend) * similarity + blend * recency,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
