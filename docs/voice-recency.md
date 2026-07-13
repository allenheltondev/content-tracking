# Voice: recency-weighted, self-evolving style learning

The Voice feature learns how a creator writes (per tenant, per platform) and
synthesizes new content in that voice. This document describes the recency
model that makes the learned voice **evolve over time, biased toward the most
recently published work**.

## Why recency weighting

A writing voice drifts: sentence rhythm tightens, signature phrases change,
formatting habits move on. A profile derived from an unweighted average of all
historical samples converges on how the person *used to* write. The fix is a
principled recency bias anchored on **publish date** (not capture time): the
newest published post is the strongest signal of the current voice.

## The model

Every voice sample carries a `publishedAt` anchor (the source post's publish
date; capture time as fallback). Influence decays exponentially with age:

```
weight = 0.5 ^ (ageInDays / halfLifeDays)
```

This is the continuous form of an exponentially-weighted moving average — the
standard recency model. Properties that make it the right choice:

- A post one half-life old carries exactly half the influence of one published
  today; two half-lives, a quarter — smooth, never zero, no arbitrary cutoff.
- The bias is controlled by a single interpretable knob: the half-life
  (`VoiceHalfLifeDays` template parameter → `VOICE_HALF_LIFE_DAYS`, default
  90 days).
- Weights are relative, so the model behaves identically for prolific and
  occasional publishers.

Samples with no parseable date get a neutral weight of 0.5 (≈ one half-life
old). Future-dated (scheduled) posts clamp to weight 1.

Implementation: `api/services/voice-recency.mjs`.

## Where the weighting applies

**1. Capture (automatic, per tenant).** `VoiceMemoryFunction` watches the
table stream for blog `Content` roots (`type=blog`). Every **published** piece
is auto-captured as a `VoiceSample` with a deterministic id
(`CONTENT-{contentId}`) and `publishedAt = publishDate ?? createdAt`:

- create/publish → sample created (which triggers embed → count → reflect)
- edit → sample re-written; the consumer re-embeds only when the text actually
  changed, and an edit counts as fresh voice signal
- unpublish/delete → the derived sample (row + vector) is removed

Drafts and non-blog types are not captured — the voice learns from what
actually shipped. Everything stays inside the tenant's `TENANT#{sub}`
partition and vectors are tenant-filtered, exactly like the rest of the app.

**2. Reflection (profile learning).** `runReflection` pulls a candidate pool
(3× the reflection window), re-selects the window by publish-date recency, and
hands the model each sample annotated with its publish date and normalized
weight share. The reflect prompt instructs: higher-weighted recent samples WIN
stylistic conflicts; older traits survive only when uncontradicted. The
half-life used is recorded on each `VoiceReflection` row for auditability.

**3. Synthesis (compose).** Both compose paths (REST + streaming) retrieve a
16-candidate pool by topical similarity, then re-rank by

```
score = (1 - λ) · similarity + λ · recencyWeight     (λ = VOICE_RECENCY_BLEND, default 0.35)
```

and keep the top 5 as few-shot examples, each annotated with its publish date.
The compose prompt tells the model to favor the more recently published
examples when styles conflict. A recent near-match therefore beats a stale
exact match, so generated content sounds like the creator *now*.

## Making the voice legible

The learned voice is surfaced for humans, not just fed to the model:

- **Portrait.** The reflection tool schema includes a `portrait` field — a
  plain-English, second-person description of how the creator writes now,
  regenerated on every reflection and stored inside `VoiceProfile.profile`.
  `formatVoiceProfile` also lifts it to the top level (`portrait`) so clients
  don't have to reach into the profile JSON.

- **`GET /voice/overview`.** For each platform profile, returns the portrait
  plus `summarizeVoiceCorpus` output: total samples, a by-source breakdown,
  the published date range, and *influence horizons*. Each horizon reports, for
  a window (30/90/365 days), the share of the current voice's total recency
  weight that comes from posts inside it — turning the decay math into a
  sentence like "the last 90 days are 71% of your voice". Undated samples
  dilute the denominator but never count toward a window's numerator.

- **`POST /voice/check`.** Grades an arbitrary draft against the voice.
  `assessVoiceMatch` runs the same recency-weighted retrieval as compose (the
  draft text is the query), then forces a `record_voice_assessment` tool call
  returning a 0-100 score, a verdict (`on_voice` / `close` / `off_voice`), a
  plain-English summary, concrete strengths and off-voice issues with fixes,
  and an optional on-voice rewrite. It judges style, not topic — an unusual
  topic can still be perfectly on-voice.

## Curating the memories

The voice is only as good as the corpus behind it, so the memories are
controllable:

- **Influence visibility.** `GET /voice/samples` annotates each sample with
  `influence_share` — the recency weight it currently carries, normalized over
  the eligible corpus. So the samples list shows exactly which memories drive
  the voice ("this post = 18% of your voice").

- **Mute (reversible, durable).** `PATCH /voice/samples/{id} { muted }` keeps
  the row but drops its vector and excludes it from reflection. Muting a
  published post is durable: `captureContentVoiceSample` skips re-capture when
  the existing sample is muted, so a later edit to the post won't silently
  bring it back. Unmuting re-embeds the sample. Delete remains for hard removal
  of pasted samples.

- **Immediate effect.** Curation actions (mute, unmute, delete, steer)
  re-derive the profile right away (best-effort — a reflection failure never
  fails the user's action), so removing a memory updates the learned voice
  without waiting for the next automatic reflection.

- **No self-training.** Reflection excludes `source: generated` samples, so the
  model's own drafts can never teach the voice about themselves — only
  authored/published work defines the profile.

- **Steering.** `PUT /voice/profiles/{platform}/steering { note }` stores a
  short intent note ("more concise, less hedging") on the profile. It's
  injected into the reflection prompt (honored where the recent samples don't
  contradict it) and preserved across reflects, so the creator can *direct* the
  voice's evolution, not just observe it.

- **History.** Each reflection snapshots the resulting profile `version` and
  `portrait`, so the reflection list doubles as a "your voice over time"
  timeline.

## Tuning

| Knob | Where | Default | Effect |
| --- | --- | --- | --- |
| `VoiceHalfLifeDays` | template parameter → `VOICE_HALF_LIFE_DAYS` | 90 | Lower = voice tracks recent posts more aggressively |
| `VOICE_RECENCY_BLEND` | env (code default) | 0.35 | 0 = pure topical similarity, 1 = pure recency in compose ranking |
| `ReflectionThreshold` | template parameter → `REFLECTION_THRESHOLD` | 5 | New samples per platform before an automatic re-reflection |

## Backfill

Run the recency-aware seed over the existing catalog once per environment so
the profile has the full published history with real publish dates:

```
node scripts/seed-voice-from-content.mjs --table <table> --region <region>          # dry-run
node scripts/seed-voice-from-content.mjs --table <table> --region <region> --apply
```

Embedding + reflection then run asynchronously via the deployed
`VoiceMemoryFunction`. Legacy vectors without `publishedAt` metadata keep
working (neutral weight) and heal to full recency ranking as posts are
re-captured or edited.
