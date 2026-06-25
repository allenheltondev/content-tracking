# Integration Design: from a toolbox to one system

> Status: **draft for discussion.** Captures the target architecture and a phased
> plan to turn the current app (a campaign/vendor analytics tool with content-AI
> features bolted on) into one integrated product. Decisions in §0 were made with
> the owner; the rest is the proposal.

## 0. Decisions locked with the owner

- **Spine:** *one unified loop* — brief/idea → create content (in your voice) →
  distribute → track → get paid → media kit → informs the next pitch.
- **Data model:** converge on *one `Content` entity* as the end state (blog /
  social / video are types of one thing). This is the destination, not phase 1.
- **Phase 1 optimizes for *fast perceived integration*** — reframe the IA and
  surface the AI in-flow on the **existing** data; defer the data migration.

## 1. Problem

Two systems share a flat 9-item nav and barely touch:

- **Business world** (campaign-scoped, `pk=CAMPAIGN#{id}`): Campaign, Brief, Link
  (roles main/cross_post), SocialPost, ContentPost, EngagementRecommendation —
  plus Vendor, Revenue/Payout, Reports. These store **pointers** (url + notes +
  analytics) to content published elsewhere, not the content itself.
- **Content world** (tenant-scoped, `pk=TENANT#{sub}`): Blog (+ cross-post copies,
  cross-post runs, vector-index state, campaign-ref), VoiceSample / VoiceProfile /
  VoiceReflection. Blog stores the actual **body** and is the only thing the
  AI (vectorization, `/blogs/ask`, voice) operates on.

Symptoms: Ask/Compose/Voice are **destinations, not capabilities**; the loop is
**open** (compose doesn't become a tracked post; a post's performance never feeds
voice); and the same real-world thing — "a piece I published" — is modeled twice
(Blog has the body + AI; ContentPost/SocialPost have the analytics + campaign).
Connections that *do* exist: `blog.campaignId` + a `BlogCampaignRef` row; the
campaign brief/draft/recommendation AI (`summarizeBrief`, `reviewDraft`,
`recommendEngagement` in `api/services/bedrock.mjs`).

## 2. The spine (the loop everything hangs off)

```
        ┌──────────────────────────────────────────────────────────┐
        │                                                          ▼
   (idea / brief) ──► CREATE ──► DISTRIBUTE ──► TRACK ──► GET PAID ──► MEDIA KIT
     Brief AI        Compose      cross-post     engagement  payouts    public kit
     suggests a      in your      + publish      + clicks    + revenue   proves reach
     campaign        voice        variants       + web vitals                │
        ▲                                          │                         │
        └────────────── informs the next pitch ◄───┴── learns your VOICE ◄───┘
```

Every existing feature already maps onto a step; today they just don't hand off
to each other. Integration = making each step produce the input to the next.

## 3. Target data model — one `Content` entity (end state)

A single tenant-scoped object that absorbs Blog + ContentPost + SocialPost and
their satellites. Mirrors the conventions in `api/domain/blog.mjs`.

```
Content root        pk=TENANT#{sub}  sk=CONTENT#{id}            entity=Content
  fields: type (blog|social|video|...), title, slug, body (markdown),
          status (draft|scheduled|published|archived), voicePlatform,
          campaignId?  (optional link to a sponsorship), tags, createdAt,
          publishedAt, gsi1pk=TENANT#{sub}#CONTENT, gsi1sk={createdAt}#{id}

Published variant   sk=CONTENT#{id}#PUBLISH#{platform}          entity=ContentPublish
  one row per place it went live: { platform, url, externalId, status,
  publishedAt }.  ← subsumes Blog cross-post copies AND ContentPost/SocialPost.

Stats snapshot      sk=CONTENT#{id}#STATS#{platform}#{date}     entity=ContentStats
  ← subsumes Social/Content post daily snapshots (engagement/views/impressions).

Vector state        sk=CONTENT#{id}#VECTORINDEX                 entity=ContentVectorIndex
  ← subsumes BlogVectorIndex; the embedding pipeline points here.
```

- **Campaign ↔ Content:** a campaign's deliverable *is* a Content row
  (`content.campaignId`); the campaign's analytics aggregate that content's
  variant stats. Vendor → Campaign is unchanged.
- **Voice:** a published variant can spawn a `VoiceSample` automatically (you
  already published it in your voice). VoiceProfile/Reflection unchanged.
- **AI unifies for free:** once everything is `Content`, `reviewDraft` works on
  any draft, `recommendEngagement` feeds the cross-post step, `/ask` and voice
  span the whole library — not just blogs.

The S3 Vectors `blog-vectors` index generalizes to a `content-vectors` index;
the stream consumer keys off `entity=Content` instead of `Blog`.

## 4. AI, re-slotted from destinations to capabilities

| Today (nav tab) | Becomes |
|---|---|
| **Compose** | The "New content" entry point: compose in voice → a Content **draft** → publish/cross-post. Reachable from the library, a campaign, and Home. |
| **Ask** | A global **command-palette** ("Ask your content", ⌘K) available everywhere + the per-item "Ask about this" (already built on BlogDetail). Not a nav tab. |
| **Voice** | The **engine behind Compose** (a panel + a manageable settings page), with the "you saved X → your voice sharpened" feedback shown inline. Demoted from primary nav. |
| Brief AI / draft review / engagement recs (already in CampaignDetail) | Wired to the `Content` object so they connect the loop (brief → content draft → review → cross-post targets). |

## 5. Information architecture (nav redesign) — *decided*

From 9 flat siblings to a lifecycle-shaped IA. **Create (your content) is the
center; the business machinery nests under Sponsorships.**

Primary nav:
- **Home** (`/`) — the spine. "What needs attention" across the loop: drafts to
  publish, posts to start tracking, payments due, voice nudges. (Extend
  `routes/Home.tsx`, which already orchestrates campaigns/revenue.)
- **Create** — the unified content library (drafts + published) with **Compose**
  as "New". Subsumes Blogs + Compose. `Content.type` includes **video**.
- **Analytics** — engagement across all content + clicks + web vitals (today's
  Insights, broadened).
- **Sponsorships ▾** — a grouped menu: **Campaigns, Vendors, Revenue, Media kit**
  (the brief→deliverable→payment→pitch business).

Out of the primary bar:
- **Ask** — global **⌘K** command palette, available everywhere; no tab.
- **Voice** — moves to a secondary spot (user menu / under Create); it's the
  engine behind Compose, surfaced in-flow, not a primary destination.
- **Profile, Settings** — stay in the user menu.

## 6. The closed loops (the payoff)

1. Compose → **Save as content** → publish/cross-post → variants → stats attach →
   top performers' traits feed **Voice** → next Compose is sharper.
2. A cross-posted copy **auto-becomes a VoiceSample**.
3. A campaign's **draft tab is a real Content draft**; `recommendEngagement` seeds
   the cross-post targets; campaign analytics aggregate the content's variants.
4. **Ask spans content + performance** ("what did my best posts have in common?").

## 7. Phasing — *foundation-first*

> **Sequencing decision (owner):** lead with the unified `Content` model, then
> layer the IA/contextual-AI integration on top — so the cohesive UX is built
> once, on the final shape, rather than reworked after a migration. Tradeoff:
> the first phase is mostly backend + migration with less immediately-visible UI;
> the integrated *feel* arrives in Phase 2.

### Phase 1 — Unify the content model ← *foundation, do first*
- Introduce the `Content` entity + published variants + stats + vector state
  (`api/domain/content.mjs`, mirroring `blog.mjs`); `type` ∈ {blog, social,
  video}, `source` ∈ {owned, sponsored}.
- **Migrate Blog → Content(type=blog, source=owned)** first (closest shape), then
  fold campaign **ContentPost/SocialPost → Content(source=sponsored) + variants**
  and their snapshots → stats. Deterministic ids, idempotent + dry-runnable
  scripts (mirror `scripts/backfill-*.mjs`), **dual-read** during transition.
- Re-point the vector stream, `/ask`, voice-seed, and cross-post at `Content`;
  campaigns reference Content. **Keep the campaign analytics path intact.**

### Phase 2 — Integration on the unified model (the visible payoff)
On the now-single `Content` entity:
- **Nav reframe** to the lifecycle (Home · Create · Analytics · Sponsorships ▾;
  Ask → ⌘K, Voice → secondary). `ui/src/App.tsx`, `ui/src/router.tsx`.
- **Create** = the unified content library (drafts + published, owned + sponsored).
- **Compose → a Content draft → publish/cross-post** (no longer a dead end).
- **Global Ask palette** (⌘K) over all Content.

### Phase 3 — Close the loops + intelligence
- Cross-post copy → VoiceSample automatically; engagement → voice feedback;
  campaign deliverable *is* Content; Ask spans content + performance; proactive
  suggestions on Home.

## 8. Risks & guardrails

- **Don't break what works:** the campaign analytics / clicks / web-vitals path is
  solid — **Phase 1's migration must preserve it** via dual-read, no big-bang
  cutover.
- **Live-data migration** (Blog/ContentPost/SocialPost): deterministic ids,
  idempotent + dry-runnable scripts, verify counts before/after, cut fallbacks
  only after staging parity.
- **Less visible early:** foundation-first means Phase 1 ships little UI; keep the
  migration tightly scoped (blogs first, then campaign posts) so Phase 2's visible
  payoff isn't far behind.

## 9. Verification

Per-phase verification lives in §11 (Phase 1) and §12 (Phase 2). Headline:
migration scripts are dry-run-then-`--apply` on staging with row-count parity, and
`/content/ask` + voice + campaign analytics must all still work before fallbacks
are cut.

## 10. Resolved decisions

1. **Campaigns nest under Sponsorships** — Create is the visual center; Campaigns
   / Vendors / Revenue / Media kit group under a "Sponsorships" menu.
2. **Video is a first-class `Content.type` now** (blog | social | video), so
   YouTube deliverables unify too.
3. **Demote Ask (→ ⌘K) and Voice (→ secondary) in Phase 1.**

## 11. Phase 1 — Content model build plan (foundation)

The data unification everything else rests on. Mirrors the conventions already
proven in `api/domain/blog.mjs` + the blog vector pipeline, and reuses the
backfill-script pattern (`scripts/backfill-*.mjs`). Dual-read keeps the app
working throughout; each sub-step is its own PR.

**11.1 `Content` entity** — new `api/domain/content.mjs` (mirror blog.mjs).
  - Root `sk=CONTENT#{id}` (entity "Content"): `type` {blog|social|video},
    `source` {owned|sponsored}, title, slug, body, status
    {draft|scheduled|published|archived}, campaignId?, tags, categories,
    canonicalUrl, links, createdAt, publishedAt; gsi1pk=`TENANT#{sub}#CONTENT`,
    gsi1sk=`{createdAt}#{id}`.
  - Children: `PUBLISH#{platform}` (variant: url/externalId/status/publishedAt),
    `STATS#{platform}#{date}` (snapshot), `VECTORINDEX` (embed state).
  - CRUD + child writers + `listContent` (GSI1; filter type/source/status) +
    cascade delete — copy shapes from blog.mjs. `api/routes/content.mjs` +
    validation; register in `app.mjs`.

**11.2 Generalize the vector + AI pipeline.**
  - New `content-vectors` S3 Vectors index (template.yaml, sibling of
    `blog-vectors`); `functions/vectorize-content` (generalize vectorize-blog)
    keyed on `entity=Content`, metadata by contentId.
  - `/blogs/ask` → `/content/ask` (keep `/blogs/ask` as a thin alias);
    `queryBlogChunks` → `queryContentChunks`. Voice-seed + Compose-save read/write
    Content.

**11.3 Migration scripts** (dry-run + `--apply`, deterministic ids, idempotent).
  - `scripts/migrate-blogs-to-content.mjs`: Blog → Content(type=blog,
    source=owned); `BLOG#{id}#CROSSPOST#{platform}` → `PUBLISH` variants; blog
    vector state → content vector state (or let the stream re-embed).
    `contentId = blogId` → clean 1:1, idempotent.
  - `scripts/migrate-campaign-posts-to-content.mjs`: ContentPost/SocialPost
    (campaign-scoped) → Content(source=sponsored, campaignId) + snapshots → STATS.
    ⚠ **Wrinkle:** campaigns are a GLOBAL pool (`pk=CAMPAIGN#{id}`), not
    tenant-partitioned, while Content is tenant-scoped — so this migration must
    resolve the owning tenant. Trivial in the single-tenant stack (one sub); needs
    an explicit owner mapping before multi-tenant.

**11.4 Dual-read transition.** List/detail read Content first, fall back to the
  legacy entities until migration is verified on staging — then cut the fallbacks.
  **Leave the campaign analytics path (clicks / web-vitals) untouched.**

**Verification:** `npm test` (api: content domain/routes/vectors + migration unit
tests); scripts dry-run → `--apply` on staging; confirm `/content/ask` + voice
still answer and campaign analytics are unchanged; row-count parity
Blog/ContentPost/SocialPost → Content.

**Sequencing:** 11.1 → 11.2 (entity + pipeline, invisible) → migrate blogs (low
risk) → migrate campaign posts (the tenant wrinkle) → 11.4 cut fallbacks.

## 12. Phase 2 — Integration UI (on the unified `Content` model)

Now that everything is `Content`, the UX integration is built once on the final
shape. Reuses `useApiFetch`, `MarkdownLazy`, `streamGenerate`, the `.card`/
`.btn-*`/`.input` tokens.

- **2.1 Nav reframe** (`ui/src/App.tsx`, `router.tsx`): **Home · Create ·
  Analytics · Sponsorships ▾**; Ask → ⌘K; Voice → user menu; new `NavMenu`.
- **2.2 Create = the content library** — list all Content (drafts + published,
  owned + sponsored), filterable by type; "New" → Compose.
- **2.3 Global Ask palette (⌘K)** — `components/CommandPalette.tsx` over all
  Content, reusing `streamGenerate`.
- **2.4 Compose → a Content draft → publish/cross-post** (no dead end).
- **2.5 Home as spine** — a Content strip (drafts + voice nudge) beside
  campaigns/revenue.

**Verification:** `npm run build` + `npm run lint`; manual staging walk of the new
nav, ⌘K ask, and Compose → draft → appears in Create → cross-post.
