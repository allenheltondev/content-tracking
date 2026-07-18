# Content Review — bringing Betterer's editing & evaluation experience into Booked

Status: **Phase 1 landed** (suggestion data model + endpoints). Later phases planned.

This document captures the evaluation of `allenheltondev/content-agent`
("Betterer") as a candidate to fold into this repo, and the phased plan for
doing it. The goal is Betterer's best parts — the distraction-free editor and
the multi-lens AI review that returns specific, acceptable/rejectable edits —
rebuilt on Booked's existing infrastructure and the `readysetcloud/rsc-core`
packages, not a lift-and-shift of Betterer's code.

## Verdict: good candidate — take the ideas and the IP, not the codebase

The concept and UX are an excellent fit. The **implementation** is heavy and
mostly redundant with what Booked already has:

- Betterer's frontend is ~36k LOC, of which the genuinely useful surface is
  ~3–4k. An entire second, orphaned editor architecture ships alongside the one
  that actually runs (`EditorModeContext`, `ModeTransitionManager`, virtualized
  / duplicate suggestion stacks, a 935-LOC `AuthContext`, an unused React Query
  dependency).
- Betterer's backend is ~23 Lambdas / ~120–150 synthesized CloudFormation
  resources for what is functionally "5 prompts + an orchestration + a table."
- Two of its headline "smart" features are wired up **broken**: the AgentCore
  learned-voice memory writes to namespace `brand-auditor/{tenant}/{content}-writing`
  but reads from `{tenant}-writing` (never matches), and the on-brand agent
  reads `brand.tone`/`brand.style` while the profile stores
  `writingTone`/`writingStyle`. The "learns your voice" magic largely isn't
  firing.

Crucially, **Booked already has lightweight versions of everything that made
Betterer heavy:**

| Betterer does it with… | Booked already has… |
| --- | --- |
| Per-agent hand-rolled `converse` tool-loop | `api/services/bedrock.mjs` → `invokeToolUse` (Converse + forced tool-use + prompt caching) |
| **AgentCore Memory** for "learned voice" (broken) | The **Voice** feature — recency-weighted vectors + reflection + `assessVoiceMatch` (`POST /voice/check`) |
| On-brand agent (separate profile) | `POST /voice/check` → score + strengths + `issues[{area,detail,suggestion}]` + rewrite |
| Editorial summarizer | `reviewDraft` → `verdict` + `issues[{severity,area,detail,suggestion}]` |
| **Step Functions** fan-out | **Lambda durable execution** (`@aws/durable-execution-sdk-js`) or a `Promise.all` orchestrator |
| **Momento Topics** + EventBridge API Destination + 2 IAM roles | **Response-streaming Function URL** (NDJSON deltas), already powering live typing |
| Own Cognito pool, own single table | Shared `RSCUserPool`; single-table with structural tenant partitioning; a **`Content` entity with an editable `content_markdown` body** and a `ContentDetail` route |

So this is not a system port. It is **adding one net-new capability —
offset-anchored, accept/reject/edit suggestions over `content_markdown` — to
surfaces Booked already owns**, reusing Booked's own patterns for the plumbing
Betterer over-built.

## What we take vs. drop

**Take (the real IP — a few hundred lines):**

1. The **5 agent system prompts** (`functions/agents/*.mjs`): scoring rubrics
   (LLM-likeness: style 35 / specificity 25 / repetition 20 / hallucination 20;
   on-brand: tone 40 / style 40 / consistency 20), red-flag taxonomies, and the
   "surgical edit only" discipline. Provider-agnostic text.
2. The **suggestion anchor model + cross-edit survival**: re-derive offsets from
   the text instead of trusting the model, store `anchorText` +
   `contextBefore`/`contextAfter` + a `contextHash`, and keep/expire suggestions
   as the body changes. → ported to `api/services/suggestion-offsets.mjs` and
   `api/domain/content-review.mjs`.
3. The **frontend offset engine** (`utils/suggestionOffsetCalculation.ts`):
   offset recalculation on accept + self-healing re-anchoring. Port near-verbatim.
4. The **editing UX**: textarea + highlight-span renderer + accept/reject/inline-edit/undo card.
5. The **tenant-injection security rule** (LLM never supplies tenantId) — which
   Booked already enforces via `identity.mjs`.

**Drop:** AgentCore Memory (Voice replaces it), Step Functions (durable Lambda /
`Promise.all`), Momento + its 4 resources (response streaming), the 5
near-identical agent Lambdas (collapse to one parameterized lens runner), the
dead frontend manager/context layer, and unused deps.

## Decisions

- **Review engine: rsc-core-native.** Each review lens runs on the
  `@readysetcloud/agent` runtime rather than as bespoke Lambdas, to exercise the
  rsc-core agent platform. See the open item under Phase 3.
- **On-brand lens: reuse Booked's Voice.** The "does this sound like you?" lens
  is wired to the existing `assessVoiceMatch` / learned Voice profile — one
  source of truth for voice — rather than porting Betterer's separate (and
  broken) on-brand agent + profile.

## Data model

Reviews and suggestions are **child rows of the `Content` entity**, so they
share its tenant partition and are swept by `deleteContent`'s
`begins_with(sk, "CONTENT#{contentId}")` cascade for free. Child rows carry no
GSI1 keys (matching every other `CONTENT#` child), so the content-list index
never sees them.

```
Review       pk=TENANT#{tenantId}  sk=CONTENT#{contentId}#REVIEW#{reviewId}
Suggestion   pk=TENANT#{tenantId}  sk=CONTENT#{contentId}#SUGGESTION#{suggestionId}
```

- **ContentReview**: `status` (`pending` → `succeeded`/`failed`),
  `contentVersion` (the content root's `updatedAt` at kickoff — the baseline the
  run and any revalidation agree on), `summary`, `lenses`, `expiresAt` (TTL
  backstop for abandoned runs; the cascade delete is the primary cleanup).
- **ContentSuggestion**: `type` (`llm|brand|fact|grammar|spelling`), `priority`,
  `reason`, `replaceWith`, the re-derived `startOffset`/`endOffset`, the anchor
  (`anchorText`, `contextBefore`, `contextAfter`, `contextHash`), `status`
  (`pending|accepted|rejected|dismissed|skipped`), `reviewId`, `contentVersion`.

`skipped` is system-only: cross-edit revalidation sets it when the author's edit
removed the anchored span, so the suggestion leaves the editor without being
counted as a rejection.

## API surface

Registered on the existing greedy-proxy API Lambda (`/{proxy+}` → `ApiFunction`),
so **no template or OpenAPI change is needed** — routes are added in `api/app.mjs`.
All routes are Cognito-only (`requireTenantId`) and 404 if the content isn't the
caller's.

| Method & path | Purpose | Phase |
| --- | --- | --- |
| `POST /content/{contentId}/reviews` | Open a review of the current draft (202; engine fills it in async) | 1 (engine dispatch: 3) |
| `GET /content/{contentId}/reviews/{reviewId}` | Poll review status + summary (reload/fallback) | 1 |
| `GET /content/{contentId}/suggestions` | Pending suggestions + latest review summary | 1 |
| `POST /content/{contentId}/suggestions/{suggestionId}/status` | Resolve a suggestion (`accepted`/`rejected`/`dismissed`) | 1 |

Request/response bodies are snake_case (matching `validation/content.mjs`);
storage is camelCase.

## Phases

### Phase 1 — Suggestion data model + endpoints ✅ (landed)

- `api/services/suggestion-offsets.mjs` — anchoring: `findActualOffsets`
  (re-derives offsets, trusting text over the model's numbers),
  `anchorSuggestion` (offsets + context window + hash), `isSuggestionAnchored`
  (cross-edit validity), `contextHash`.
- `api/domain/content-review.mjs` — persistence + lifecycle:
  `createReview`/`getReview`/`completeReview`/`getLatestReview`,
  `recordSuggestions` (anchors, drops unfindable spans, dedupes by
  `contextHash`), `listSuggestions`, `updateSuggestionStatus`,
  `revalidateSuggestions` (keep/skip across edits).
- `api/validation/content-review.mjs` — request validation + snake_case DTOs.
- `api/routes/content-review.mjs` — the four routes above.
- Tests: `suggestion-offsets`, `domain-content-review`, `route-content-review`
  (28 tests). Full suite green (1106 tests), lint clean.

`recordSuggestions` and `completeReview` are the seams the engine (Phase 3)
calls; they're implemented and tested now, ahead of the engine.

### Phase 2 — Cross-edit revalidation wiring ✅ (landed)

`revalidateSuggestions` is now wired to a DynamoDB-stream consumer, mirroring
`VectorizeContentFunction`/`VoiceMemoryFunction`:

- `functions/revalidate-suggestions/index.mjs` — a third event-source mapping on
  the shared table stream, filtered to Content root **MODIFY** (INSERT can't have
  suggestions yet; REMOVE is handled by the delete cascade). The handler compares
  the old vs new `contentMarkdown` and no-ops when the body is unchanged (a
  title/link/id edit), so only real body edits trigger revalidation. Still-valid
  suggestions are re-anchored to the new body; ones the edit removed are marked
  `skipped`. It writes only `ContentSuggestion` rows, which the filter never
  matches, so it can't re-trigger itself.
- `template.yaml` — `RevalidateSuggestionsFunction` + `RevalidateSuggestionsDLQ`,
  scoped to stream read + `Query`/`UpdateItem` on the table + DLQ send.
- Tests: `functions/revalidate-suggestions/index.test.mjs` (6 tests — body-change
  triggers, unchanged/​non-MODIFY/​non-Content no-ops, cleared-body, batch).

Edit application itself stays client-side (the editor owns the live text + offset
recalculation); the server records the decision and keeps the *other* pending
suggestions correctly anchored.

### Phase 3 — The review engine (rsc-core-native)

One review = fan-out across lenses over `content.contentMarkdown`, each recording
anchored suggestions via `recordSuggestions`, then a summarizer closing the run
via `completeReview`. Lens inventory (ported prompts):

- **grammar / spelling** — readability metrics + clarity edits.
- **llm** — AI-tell detector (the red-flag taxonomy).
- **fact** — claim extraction + web-search verification (needs a real tool
  loop; natural fit for an `@readysetcloud/agent` session with a web-search MCP
  gateway, mirroring the existing blog-search gateway).
- **brand** — **reuse Voice**: grade against the learned Voice profile via the
  same retrieval as `assessVoiceMatch`, emitting off-voice spans as `brand`
  suggestions.
- **summary** — synthesize the lens outputs into the review `summary`.

Orchestration uses Booked's chosen primitive (Lambda durable execution or a
`Promise.all` orchestrator), **not** Step Functions. Completion is pushed to the
UI over a **response-streaming Function URL** (NDJSON per-lens/per-suggestion),
**not** Momento; `GET .../reviews/{reviewId}` is the reload fallback.

> **Open item / blocker for this phase.** The rsc-core-native engine needs the
> `@readysetcloud/agent` in-package API for *defining* agents/tools/memory. The
> only surface reconstructable from this repo is `requestSession` (session
> creation); the agent/tool/model/memory-definition API isn't exercised here, and
> `readysetcloud/rsc-core` can't be added to a session already scoped to
> `allenheltondev` repos (cross-owner restriction). **To implement Phase 3, start
> a session with `readysetcloud/rsc-core` as a source (or provide the
> `@readysetcloud/agent` API surface).** The Phase 1/2 work is engine-independent
> and unblocked.

### Phase 4 — The editor + suggestion UX (frontend)

On the existing `ContentDetail` route (`ui/src/routes/ContentDetail.tsx`), using
`@readysetcloud/ui` chrome and Booked's React Query + `useApiFetch` patterns:

- Port `utils/suggestionOffsetCalculation.ts` (offset recalculation + self-healing
  re-anchoring) near-verbatim.
- Port the plain-textarea + highlight-span renderer (`SimpleSuggestionHighlights`)
  and the accept/reject/inline-edit/undo card (`SuggestionActionButtons` +
  `DraggableActiveSuggestionArea`), dropping the orphaned manager/context layer.
- "Start Review" → `POST /content/{id}/reviews`; subscribe to the review stream
  for live suggestions; fall back to `GET .../suggestions`.
- Accept applies the edit locally, recalculates downstream offsets, then
  `POST .../suggestions/{id}/status`. Save persists via the existing
  `PATCH /content/{id}` (`content_markdown`), which triggers Phase 2 revalidation.

## How this satisfies the rsc-core requirement

- `@readysetcloud/ui` — all editor chrome, modals, toasts, auth (already the
  design system across Booked's UI).
- `@readysetcloud/agent` — the fact-check lens (and, per the Phase 3 decision,
  the other lenses) run on the hosted agent runtime; the fact lens gets a
  web-search MCP gateway mirroring the existing blog-search gateway.
- Existing rsc-core seams reused: the shared `RSCUserPool`, the Badge Chest
  (`trackActivity`) for gamifying reviews, and the Voice feature that replaces
  Betterer's AgentCore learned-voice memory.
