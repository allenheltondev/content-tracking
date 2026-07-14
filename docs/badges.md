# Usage badges (Badge Chest integration)

Booked earns its users badges through the shared **Badge Chest** in
[`readysetcloud/rsc-core`](https://github.com/readysetcloud/rsc-core). There is
one chest per person, keyed on their Cognito `sub` — the same identity in every
Ready, Set, Cloud app — so badges earned in Booked roll up into the same profile
as bootcamp lessons, newsletter subscriptions, and everything else.

This stack does exactly **one** thing in that system: it **emits activity**.
An activity is a fact ("user X did Y"). The central rules engine in rsc-core
owns the catalog, decides whether an activity earns a badge, what it's worth,
and how points/levels roll up. Booked never makes any of those decisions.

## How emission works here

- [`api/services/activity.mjs`](../api/services/activity.mjs) — `trackActivity(userId, action, opts)`
  puts a `Track Activity` event on the **default EventBridge bus**, which
  rsc-core's `ProcessActivityFunction` consumes (it matches on
  `detail-type: "Track Activity"`). Both stacks share one AWS account and one
  Cognito pool, so the `sub` we already resolve per request
  ([`services/identity.mjs`](../api/services/identity.mjs)) is the badge identity.
- Emission is **best-effort**: every failure is swallowed with a warning so a
  badge write can never fail, slow, or change the outcome of a user's request.
- Emission is **off unless `BADGE_ACTIVITY_ENABLED=true`** (set on the API
  Lambda in `template.yaml`), so tests and un-opted contexts never touch
  EventBridge.
- Every event is scoped to `service: "booked"`, because the booked badges use
  `criteria.service: "booked"` — a per-service counter that only advances when
  the activity carries a matching `service`.
- The `events:PutEvents` grant on the API Lambda is scoped to the default bus.

The activity contract (action naming, service scoping, idempotency ids, criteria
types, "no automatic backfill" gotcha) is documented authoritatively in
rsc-core's [`functions/badges/AGENTS.md`](https://github.com/readysetcloud/rsc-core/blob/main/functions/badges/AGENTS.md).

## The badges

Seven usage badges spanning Booked's pillars — deals, voice, radar, and the
media kit — plus a capstone. `first-campaign` / **Deal Maker** already exists in
the rsc-core catalog but **had no emitter**, so it could never be earned; wiring
`campaign.created` in this PR makes it (and the new `Rainmaker` tier) live.

| Badge | id | Tier | Earned when | Metric (emit point) |
| --- | --- | --- | --- | --- |
| **Deal Maker** *(exists)* | `first-campaign` | bronze | Track your first paid campaign | `campaign.created` — `POST /campaigns` |
| **Rainmaker** | `booked-rainmaker` | gold | Track 10 paid campaigns | `campaign.created` (same emit, threshold 10) |
| **Found Your Voice** | `voice-trained` | bronze | Capture your first writing sample | `voice.sample.captured` — `POST /voice/samples` |
| **Ghostwriter** | `ghostwriter` | silver | Compose 10 drafts in your voice | `voice.composed` — `POST /voice/compose` |
| **On the Radar** | `radar-online` | bronze | Add your first Content Radar feed | `radar.feed.added` — `POST /content-radar/feeds` |
| **Press Ready** | `press-ready` | silver | Publish your public media kit | `mediakit.published` — `POST /media-kit/publish` |
| **Booked & Busy** | `booked-and-busy` | platinum | Earn all four pillar badges | *meta — no emit* |

Idempotency: create-style activities carry a deterministic id
(`<action>#<userId>#<entityId>`) so a retried `Idempotency-Key` can't
double-count. `voice.composed` has no persisted entity, so it omits an id — an
occasional double-count is harmless for a count-up-to-N badge.

## Follow-on PR — register the badges in rsc-core

The emitters above are live in this stack, but a metric with no catalog entry is
a **cheap no-op in the engine** — nothing awards until these entries land in
`readysetcloud/rsc-core` at `functions/badges/catalog.json`. Add the six new
badges below (keep the existing `first-campaign` entry as-is) and bump the
catalog `version`. Because there is **no automatic backfill**, users who already
passed a threshold earn the badge on their *next* matching activity.

```jsonc
// Add to the "badges" array in functions/badges/catalog.json (and bump "version").
// "first-campaign" is already present — do not duplicate it.
{
  "id": "booked-rainmaker",
  "name": "Rainmaker",
  "description": "Tracked 10 paid campaigns in Booked.",
  "icon": "🌧️",
  "category": "Creators",
  "tier": "gold",
  "points": 100,
  "service": "booked",
  "criteria": { "type": "count", "metric": "campaign.created", "threshold": 10, "service": "booked" }
},
{
  "id": "voice-trained",
  "name": "Found Your Voice",
  "description": "Captured your first writing sample so Booked can learn your voice.",
  "icon": "🎙️",
  "category": "Creators",
  "tier": "bronze",
  "points": 20,
  "service": "booked",
  "criteria": { "type": "count", "metric": "voice.sample.captured", "threshold": 1, "service": "booked" }
},
{
  "id": "ghostwriter",
  "name": "Ghostwriter",
  "description": "Composed 10 drafts in your own voice.",
  "icon": "✍️",
  "category": "Creators",
  "tier": "silver",
  "points": 75,
  "service": "booked",
  "criteria": { "type": "count", "metric": "voice.composed", "threshold": 10, "service": "booked" }
},
{
  "id": "radar-online",
  "name": "On the Radar",
  "description": "Added your first Content Radar feed source.",
  "icon": "📡",
  "category": "Creators",
  "tier": "bronze",
  "points": 15,
  "service": "booked",
  "criteria": { "type": "count", "metric": "radar.feed.added", "threshold": 1, "service": "booked" }
},
{
  "id": "press-ready",
  "name": "Press Ready",
  "description": "Published your public, brand-facing media kit.",
  "icon": "📣",
  "category": "Creators",
  "tier": "silver",
  "points": 50,
  "service": "booked",
  "criteria": { "type": "count", "metric": "mediakit.published", "threshold": 1, "service": "booked" }
},
{
  "id": "booked-and-busy",
  "name": "Booked & Busy",
  "description": "Closed a deal, trained your voice, tuned your radar, and published your kit.",
  "icon": "🏆",
  "category": "Creators",
  "tier": "platinum",
  "points": 200,
  "service": "booked",
  "criteria": {
    "type": "meta",
    "badges": ["first-campaign", "voice-trained", "radar-online", "press-ready"],
    "threshold": 4
  }
}
```
