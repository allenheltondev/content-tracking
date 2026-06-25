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

## 5. Information architecture (nav redesign)

From 9 flat siblings to a lifecycle-shaped IA:

- **Home** — the spine. "What needs attention" across the loop: drafts to publish,
  posts to start tracking, payments due, voice nudges. (Extend `routes/Home.tsx`,
  which already orchestrates campaigns/revenue.)
- **Create** — the unified content library (drafts + published) with **Compose**
  as "New". Subsumes Blogs + Compose.
- **Campaigns** — sponsorships (brief → deliverable → payment); **Vendors** &
  **Revenue** live here/adjacent.
- **Analytics** — engagement across all content + clicks + web vitals (today's
  Insights, broadened to all content).
- **Voice**, **Media kit**, **Settings** — secondary (under Create / a menu).
- **Ask** — global ⌘K, no tab.

## 6. The closed loops (the payoff)

1. Compose → **Save as content** → publish/cross-post → variants → stats attach →
   top performers' traits feed **Voice** → next Compose is sharper.
2. A cross-posted copy **auto-becomes a VoiceSample**.
3. A campaign's **draft tab is a real Content draft**; `recommendEngagement` seeds
   the cross-post targets; campaign analytics aggregate the content's variants.
4. **Ask spans content + performance** ("what did my best posts have in common?").

## 7. Phasing

### Phase 1 — Perceived integration (no data migration) ← *do this first*
On the existing Blog/ContentPost/SocialPost/Voice entities:
- **Nav reframe** to the lifecycle (group the items into Create / Campaigns /
  Analytics; demote Ask to ⌘K, Voice to secondary). `ui/src/App.tsx`,
  `ui/src/router.tsx`.
- **Contextual AI / close cheap loops on current data:**
  - Compose → **"Save as blog"** (creates a Blog via the existing `createBlogPost`
    API) and inline cross-post — Compose stops being a dead end.
  - **Global Ask palette** (⌘K) reusing the streaming client.
  - Auto-create a **VoiceSample from a successful cross-post copy**.
  - **Home** surfaces drafts/voice nudges next to campaigns/revenue.
- *Ships something that feels like one product within a small, low-risk change set.*

### Phase 2 — Unify the content model
- Introduce the `Content` entity + variants + stats + vector state
  (`api/domain/content.mjs`, mirroring `blog.mjs`).
- Migrate **Blog → Content(type=blog)** first (closest shape; deterministic ids,
  idempotent script like `scripts/backfill-*.mjs`, dual-read during transition),
  then fold ContentPost/SocialPost in as Content + variants.
- Re-point the vector stream, `/ask`, and voice at `Content`; campaigns reference
  Content. Keep the campaign analytics that already works intact.

### Phase 3 — Full closed loops + intelligence
- Engagement → voice feedback; cross-content Ask incl. performance; campaign
  deliverable *is* Content; proactive suggestions on Home.

## 8. Risks & guardrails

- **Don't break what works:** the campaign analytics / clicks / web-vitals path is
  solid — Phase 2 must preserve it (dual-read, no big-bang cutover).
- **Live-data migration** (Blog/ContentPost/SocialPost): deterministic ids,
  idempotent + dry-runnable scripts, verify counts before/after.
- **Scope discipline:** Phase 1 must land visibly fast; resist starting the model
  migration inside it.

## 9. Verification (per phase)

- **Phase 1:** `npm test` (api), `npm run build` + `npm run lint` (ui); manual walk
  of the new nav and the Compose → save-as-blog → cross-post → voice-sample loop on
  staging.
- **Phase 2:** migration scripts dry-run then `--apply` on staging; confirm
  vector/ask/voice still answer and campaign analytics are unchanged; row-count
  parity Blog/ContentPost/SocialPost → Content.

## 10. Open questions for the owner

1. **Campaigns' place in the IA** — peer of Create, or nested under a
   "Sponsorships" area? (Spine says one loop, but campaigns are a big subsystem.)
2. **Video** — is it in scope for `Content.type`, or blog+social only for now?
3. **Phase-1 nav** — comfortable demoting **Ask** to ⌘K and **Voice** to secondary,
   or keep them as tabs until Phase 2?
