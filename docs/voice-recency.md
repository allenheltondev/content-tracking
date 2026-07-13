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
