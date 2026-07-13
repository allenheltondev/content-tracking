# API reference

Complete reference for the Booked REST API. Schemas are
derived from [`publicapi.yaml`](../publicapi.yaml); that file is the
source of truth.

## Conventions

- **Base URL:** the `ContentTrackingApiBaseUrl` stack output. Shape:
  `https://<api-id>.execute-api.us-east-1.amazonaws.com/v1`.
- **Authentication:** every route requires an `Authorization` header
  containing a Cognito access token issued by the `RSCUserPool`. Missing
  or invalid tokens return `401 Unauthorized` from API Gateway before
  reaching the handler.
- **Content type:** request and response bodies are `application/json`.
- **IDs:** vendor IDs are ULIDs matching `^[0-9A-HJKMNP-TV-Z]{26}$`.
  Campaign and link IDs are opaque strings (1-64 chars).
- **Errors:** all error responses use the shape `{ "message": "..." }`
  unless noted. `400` responses from request validation include the
  validator's detail in `message`.

## Status code summary

| Code | Meaning |
| --- | --- |
| 200 | Successful read or update |
| 201 | Resource created |
| 204 | Resource deleted (no body) |
| 400 | Validation failure (missing field, wrong type, pattern mismatch) |
| 401 | Missing or invalid Cognito token |
| 404 | Resource not found |
| 409 | Conflict (vendor has linked campaigns and cannot be deleted) |
| 502 | Upstream newsletter-service call failed |
| 500 | Unexpected server error |

---

## Campaigns

### POST /campaigns

Create a campaign.

**Authentication:** Cognito.

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | 1-200 chars |
| `sponsor` | string | no | <=200 chars. Legacy free-form field; prefer `vendor_id` |
| `vendor_id` | string | no | ULID. Also writes a campaign-by-vendor index entry |
| `startDate` | string (date) | no | ISO 8601 date |
| `endDate` | string (date) | no | ISO 8601 date |
| `status` | enum | no | `draft` \| `active` \| `completed` (default `active`) |
| `targetMetrics` | object | no | Free-form sponsor targets, stored as-is |
| `payout` | object | no | See [Payout](#payout-object) |
| `blog_url` | string (uri) | no | Published blog post URL, absolute http(s), <=2048 chars. Used by [web analytics](#get-campaignscampaignidweb-analytics) |

Example:

```json
{
  "name": "Q3 Launch with Acme",
  "vendor_id": "01HZX7M6Z5GQK6T7Q8N9R0P1V2",
  "startDate": "2026-07-01",
  "endDate": "2026-09-30",
  "status": "active",
  "payout": {
    "amount": 2500,
    "currency": "USD"
  }
}
```

**Responses:**

- `201 Created` - returns the [Campaign](#campaign-object).
- `400 Bad Request` - validation failure.
- `500 Internal Server Error`.

Example success body:

```json
{
  "campaign_id": "01HZX7P1F0Q3WJX5T2J9C8R6KT",
  "name": "Q3 Launch with Acme",
  "sponsor": null,
  "vendor_id": "01HZX7M6Z5GQK6T7Q8N9R0P1V2",
  "startDate": "2026-07-01",
  "endDate": "2026-09-30",
  "status": "active",
  "targetMetrics": null,
  "payout": {
    "amount": 2500,
    "currency": "USD",
    "paid": false,
    "paid_at": null,
    "invoice_ref": null
  },
  "created_at": "2026-05-22T14:03:11.512Z"
}
```

---

### GET /campaigns/{campaignId}

Get a campaign and its registered links.

**Authentication:** Cognito.

**Path parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `campaignId` | string | 1-64 chars |

**Responses:**

- `200 OK` - `{ "campaign": Campaign, "links": [Link, ...], "social_posts": [SocialPost, ...], "brief": Brief | null, "draft": Draft | null }`.
- `404 Not Found` - campaign does not exist.
- `500 Internal Server Error`.

Example success body:

```json
{
  "campaign": {
    "campaign_id": "01HZX7P1F0Q3WJX5T2J9C8R6KT",
    "name": "Q3 Launch with Acme",
    "status": "active",
    "created_at": "2026-05-22T14:03:11.512Z"
  },
  "links": [
    {
      "campaign_id": "01HZX7P1F0Q3WJX5T2J9C8R6KT",
      "link_id": "01HZX7Q9A2K3N5T8WJ6Z1Y0XBC",
      "code": "Ab3Xq9",
      "short_url": "https://rdyset.click/c/Ab3Xq9",
      "role": "main",
      "platform": "readysetcloud",
      "url": "https://readysetcloud.io/blog/post",
      "src": null,
      "notes": null,
      "expires_at": "2028-05-22T14:03:11.512Z",
      "created_at": "2026-05-22T14:03:11.512Z"
    }
  ]
}
```

---

### GET /campaigns/{campaignId}/analytics

Roll up click analytics across every link in a campaign. Fans out to
newsletter-service's per-code analytics endpoint and aggregates the
results client-side.

**Authentication:** Cognito.

**Path parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `campaignId` | string | 1-64 chars |

**Responses:**

- `200 OK` - [CampaignAnalytics](#campaignanalytics-object). Partial
  upstream failures surface in `upstream_failures` and on per-link
  `error` fields. The `total_clicks` figure excludes failed links.
- `404 Not Found` - campaign does not exist.
- `502 Bad Gateway` - every upstream analytics call failed.
- `500 Internal Server Error`.

Example success body:

```json
{
  "campaign_id": "01HZX7P1F0Q3WJX5T2J9C8R6KT",
  "link_count": 3,
  "total_clicks": 421,
  "by_role": {
    "main": 312,
    "cross_post": 87,
    "social_promo": 22
  },
  "by_platform": {
    "readysetcloud": 312,
    "medium": 87,
    "x": 22
  },
  "upstream_failures": 0,
  "links": [
    {
      "link_id": "01HZX7Q9A2K3N5T8WJ6Z1Y0XBC",
      "code": "Ab3Xq9",
      "role": "main",
      "platform": "readysetcloud",
      "url": "https://readysetcloud.io/blog/post",
      "total_clicks": 312,
      "first_click_at": "2026-05-22T16:10:01.000Z",
      "last_click_at": "2026-06-04T08:22:14.000Z",
      "error": null
    }
  ]
}
```

---

### GET /campaigns/{campaignId}/web-analytics

GA4 traffic and Core Web Vitals for the campaign's `blog_url`. GA4 metrics
are filtered to the URL's path; Core Web Vitals use the full URL (real-user
CrUX data, falling back to a PageSpeed Insights lab run when CrUX has no
data for the URL). Each source is fetched independently — a failure or
missing configuration in one is reported inline on that section's
`configured`/`error` fields rather than failing the whole call. Requires
the GA4 and CrUX credentials to be set via [`PUT /profile`](#put-profile).

**Authentication:** Cognito.

**Path parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `campaignId` | string | 1-64 chars |

**Query parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `startDate` | string (date) | ISO 8601 inclusive. Defaults to 28 days ago |
| `endDate` | string (date) | ISO 8601 inclusive. Defaults to today |

**Responses:**

- `200 OK` - [WebAnalytics](#webanalytics-object).
- `400 Bad Request` - campaign has no `blog_url`, or the date range is invalid.
- `404 Not Found` - campaign does not exist.
- `500 Internal Server Error`.

Example success body:

```json
{
  "campaign_id": "01HZX7P1F0Q3WJX5T2J9C8R6KT",
  "blog_url": "https://readysetcloud.io/blog/q3-launch",
  "page_path": "/blog/q3-launch",
  "range": { "startDate": "2026-04-29", "endDate": "2026-05-27" },
  "ga4": {
    "configured": true,
    "error": null,
    "property_id": "123456789",
    "page_path": "/blog/q3-launch",
    "totals": {
      "pageviews": 4210,
      "users": 3380,
      "sessions": 3702,
      "avg_session_duration": 96.4,
      "engagement_rate": 0.72,
      "bounce_rate": 0.28
    },
    "by_day": { "2026-05-26": 180, "2026-05-27": 142 }
  },
  "core_web_vitals": {
    "configured": true,
    "error": null,
    "source": "crux",
    "url": "https://readysetcloud.io/blog/q3-launch",
    "metrics": {
      "lcp_ms": 2100,
      "cls": 0.04,
      "inp_ms": 180,
      "fcp_ms": 1400,
      "ttfb_ms": 600
    }
  }
}
```

When an integration isn't configured, its section is
`{ "configured": false, "error": null }`. When the PageSpeed Insights
fallback is used, `source` is `psi`, `inp_ms` is `null` (INP is a
field-only metric), and the section adds `strategy`, `performance_score`,
and `tbt_ms`.

---

### PATCH /campaigns/{campaignId}/payout

Partial update of a campaign's payout. Fields omitted from the body are
left unchanged.

**Authentication:** Cognito.

**Path parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `campaignId` | string | 1-64 chars |

**Request body** (all fields optional):

| Field | Type | Notes |
| --- | --- | --- |
| `amount` | number | `>= 0` |
| `currency` | string | ISO 4217 alphabetic code (`^[A-Z]{3}$`) |
| `paid` | boolean | Setting `true` without `paid_at` defaults `paid_at` to today. Setting `false` without `paid_at` clears it. |
| `paid_at` | string (date) \| null | Only `paid_at` and `invoice_ref` accept explicit `null` |
| `invoice_ref` | string \| null | <=200 chars |

Example request:

```json
{
  "paid": true,
  "invoice_ref": "INV-2026-0142"
}
```

**Responses:**

- `200 OK` - updated [Campaign](#campaign-object).
- `400 Bad Request` - validation failure.
- `404 Not Found` - campaign does not exist.
- `500 Internal Server Error`.

---

## Links

### POST /campaigns/{campaignId}/links

Register a link in a campaign. Mints a short code via newsletter-service
and saves the Link metadata under the campaign.

**Authentication:** Cognito.

**Path parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `campaignId` | string | 1-64 chars |

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `role` | enum | yes | `main` \| `cross_post` \| `social_promo` |
| `platform` | string | yes | 1-64 chars; free-form label (`readysetcloud`, `medium`, `devto`, `linkedin`, `x`, `bluesky`, `hashnode`, ...) |
| `url` | string | yes | Destination URL, http or https, <=2048 chars |
| `src` | string | no | <=64 chars. Default traffic-source label baked into the short link |
| `notes` | string | no | <=1000 chars |
| `expiresInDays` | integer | no | 1-1825. Overrides newsletter-service's default (730 days) |

Example:

```json
{
  "role": "main",
  "platform": "readysetcloud",
  "url": "https://readysetcloud.io/blog/q3-launch",
  "src": "newsletter",
  "expiresInDays": 365
}
```

**Responses:**

- `201 Created` - [Link](#link-object).
- `400 Bad Request` - validation failure.
- `404 Not Found` - campaign does not exist.
- `502 Bad Gateway` - mint upstream rejected the request or was
  unavailable. Body includes upstream detail when available.
- `500 Internal Server Error`.

Example success body:

```json
{
  "campaign_id": "01HZX7P1F0Q3WJX5T2J9C8R6KT",
  "link_id": "01HZX7Q9A2K3N5T8WJ6Z1Y0XBC",
  "code": "Ab3Xq9",
  "short_url": "https://rdyset.click/c/Ab3Xq9",
  "role": "main",
  "platform": "readysetcloud",
  "url": "https://readysetcloud.io/blog/q3-launch",
  "src": "newsletter",
  "notes": null,
  "expires_at": "2027-05-22T14:03:11.512Z",
  "created_at": "2026-05-22T14:03:11.512Z"
}
```

---

### GET /campaigns/{campaignId}/links/{linkId}/analytics

Click analytics for a specific link. Looks up the link locally to find
its short code, then proxies to newsletter-service's
`GET /links/{code}/analytics`.

**Authentication:** Cognito.

**Path parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `campaignId` | string | Campaign owning the link |
| `linkId` | string | Link to fetch analytics for |

**Responses:**

- `200 OK` - [LinkAnalytics](#linkanalytics-object).
- `404 Not Found` - link does not exist under this campaign.
- `502 Bad Gateway` - upstream analytics service failure.
- `500 Internal Server Error`.

Example success body:

```json
{
  "campaign_id": "01HZX7P1F0Q3WJX5T2J9C8R6KT",
  "link_id": "01HZX7Q9A2K3N5T8WJ6Z1Y0XBC",
  "code": "Ab3Xq9",
  "role": "main",
  "platform": "readysetcloud",
  "url": "https://readysetcloud.io/blog/q3-launch",
  "analytics": {
    "code": "Ab3Xq9",
    "total_clicks": 312,
    "by_day": {
      "2026-05-22": 184,
      "2026-05-23": 128
    },
    "by_src": {
      "newsletter": 281,
      "social": 31
    },
    "first_click_at": "2026-05-22T16:10:01.000Z",
    "last_click_at": "2026-06-04T08:22:14.000Z"
  }
}
```

---

## Social posts

Social posts are the actual published posts on a platform (the tweet, the
LinkedIn update, the Instagram post) — distinct from the short [Links](#links)
the stack mints for click tracking. They're registered against a campaign
and live under the campaign partition. The Booked Chrome extension reads the
post URLs for active campaigns and writes captured engagement metrics back
via `PUT .../analytics`.

`GET /campaigns/{campaignId}` includes a `social_posts` array alongside
`links` and `brief`.

### POST /campaigns/{campaignId}/social-posts

Register a social post on a campaign.

**Authentication:** Cognito.

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `url` | string | yes | The post's public URL, http or https, <=2048 chars |
| `platform` | enum | no | `twitter` \| `linkedin` \| `instagram`. Inferred from the URL host when omitted |
| `notes` | string | no | <=1000 chars |

**Responses:**

- `201 Created` - [SocialPost](#socialpost-object).
- `400 Bad Request` - validation failure (bad URL, unknown/uninferable platform).
- `404 Not Found` - campaign does not exist.
- `500 Internal Server Error`.

Example success body:

```json
{
  "campaign_id": "01HZX7P1F0Q3WJX5T2J9C8R6KT",
  "post_id": "01J0A2B3C4D5E6F7G8H9JKMNPQ",
  "platform": "twitter",
  "url": "https://x.com/you/status/1790000000000000001",
  "notes": null,
  "analytics": null,
  "last_fetched": null,
  "captured_at": null,
  "created_at": "2026-05-27T14:03:11.512Z",
  "updated_at": null
}
```

---

### GET /campaigns/{campaignId}/social-posts

List the social posts registered on a campaign, oldest first.

**Authentication:** Cognito.

**Responses:**

- `200 OK` - `{ "campaign_id": "...", "social_posts": [SocialPost, ...] }`.
- `500 Internal Server Error`.

---

### PUT /campaigns/{campaignId}/social-posts/{postId}/analytics

Replace a post's engagement metrics. This is the extension's write path.
The server stamps `last_fetched` with its own clock on every write;
`captured_at` records when the client observed the numbers.

**Authentication:** Cognito.

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `metrics` | object | yes | Map of metric name (1-40 chars) to a non-negative finite number. 1-30 keys. Open set, e.g. `likes`, `reposts`, `replies`, `comments`, `views`, `impressions` |
| `capturedAt` | string | no | ISO date-time the client captured the metrics |

Example:

```json
{
  "metrics": { "likes": 50, "reposts": 7, "replies": 3, "views": 12345 },
  "capturedAt": "2026-05-27T14:02:59.000Z"
}
```

**Responses:**

- `200 OK` - the updated [SocialPost](#socialpost-object).
- `400 Bad Request` - validation failure.
- `404 Not Found` - post does not exist under this campaign.
- `500 Internal Server Error`.

---

### DELETE /campaigns/{campaignId}/social-posts/{postId}

Remove a tracked social post.

**Authentication:** Cognito.

**Responses:**

- `204 No Content`.
- `404 Not Found` - post does not exist under this campaign.

---

### GET /social-posts/active

Every social post belonging to a currently-active campaign, with the
campaign name attached. The feed the Chrome extension polls.

**Authentication:** Cognito.

**Responses:**

- `200 OK` - `{ "social_posts": [ { campaign_name, ...SocialPost }, ... ] }`.
- `500 Internal Server Error`.

---

## Drafts

A draft is the work-in-progress document for a campaign — almost always a
Google Doc. Each campaign has at most one draft (saving a new link replaces
the prior one). `GET /campaigns/{campaignId}` includes a `draft` object.

The AI review pulls the draft's text via the Google Docs public export
endpoint, so the doc must be shared so **anyone with the link can view**,
then assesses it against the campaign's [brief](#campaigns).

### POST /campaigns/{campaignId}/draft

Store (or replace) the link to the campaign's draft.

**Authentication:** Cognito.

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `url` | string | yes | http(s) URL. Only Google Docs links can be auto-reviewed; others are stored with `doc_id: null` |

**Responses:**

- `201 Created` - [Draft](#draft-object).
- `400 Bad Request` - missing or malformed URL.
- `404 Not Found` - campaign does not exist.
- `500 Internal Server Error`.

---

### GET /campaigns/{campaignId}/draft

Get the campaign's draft link and its latest review.

**Authentication:** Cognito.

**Responses:**

- `200 OK` - [Draft](#draft-object).
- `404 Not Found` - no draft attached.
- `500 Internal Server Error`.

---

### POST /campaigns/{campaignId}/draft/review

Have the AI review the draft against the campaign brief. Fetches the draft
text from Google Docs, runs the review through Bedrock, stores the feedback
on the draft, and returns it.

**Authentication:** Cognito.

**Responses:**

- `201 Created` - [Draft](#draft-object) with `review` populated.
- `400 Bad Request` - no draft/brief attached, the draft isn't a Google Docs link, or the doc isn't publicly viewable.
- `404 Not Found` - no draft attached.
- `502 Bad Gateway` - the doc fetch or the model call failed.
- `500 Internal Server Error`.

Example success body:

```json
{
  "url": "https://docs.google.com/document/d/1AbC.../edit",
  "doc_id": "1AbC...",
  "review": {
    "verdict": "minor_revisions",
    "summary": "Strong draft that covers the brief; tighten the intro and add the pricing mention.",
    "brief_alignment": "Covers the required product walkthrough but omits the pricing callout the brief asks for.",
    "strengths": ["Clear structure", "Concrete examples"],
    "issues": [
      {
        "severity": "medium",
        "area": "brief-coverage",
        "detail": "The brief requires a mention of the launch pricing; the draft never states it.",
        "suggestion": "Add a sentence in the closing section with the launch price."
      }
    ],
    "missing_requirements": ["Launch pricing callout"]
  },
  "reviewed_at": "2026-05-27T14:30:00.000Z",
  "created_at": "2026-05-27T14:03:11.512Z",
  "updated_at": "2026-05-27T14:30:00.000Z"
}
```

---

## Content post recommendations

On-demand AI suggestions for where else to cross-post or promote a content
post (the campaign's published "work item") to boost engagement. When
generating, the agent makes a best-effort fetch of the post's text and feeds
it to the model so recommendations key off what the piece actually says. When
the post is on the creator's configured
[`personal_site_url`](#put-profile), it pulls that site's prebuilt plaintext
(`<url>/index.txt`); for other URLs it does a plain GET and strips the HTML to
text. Fetching is skipped silently when the page can't be retrieved (paywall,
bot block, JS-only render, missing `.txt`, timeout), and a personal-site page
whose `.txt` is missing falls back to HTML scraping. It also reads the
campaign's
distribution history — the brief, where the piece is already cross-posted
(cross-post [links](#links) and the campaign's other content posts), and
what's already been said about it on social ([social posts](#social-posts)
and their notes) — so it doesn't recommend channels you've already used or
repeat angles you've already posted. Recommendations are generated on
request, not automatically on content-post creation, since each generation
fetches the page and calls Bedrock.

The most recent set is stored on the content post and can be re-read without
re-running the model.

### POST /campaigns/{campaignId}/content-posts/{postId}/recommendations

Generate a fresh set of recommendations for the content post and store them.

**Authentication:** Cognito.

**Request body:** optional.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `goal` | string | no | Up to 500 chars of free-text guidance to steer the model (e.g. "we want developer signups, not vanity reach"). |

**Responses:**

- `201 Created` - [EngagementRecommendation](#engagementrecommendation-object).
- `400 Bad Request` - malformed body or an over-long `goal`.
- `404 Not Found` - campaign or content post does not exist.
- `502 Bad Gateway` - the model call failed (nothing is stored; retry re-runs).
- `500 Internal Server Error`.

Example success body:

```json
{
  "campaign_id": "01HV0AABBCCDDEEFFGGHHJJKKM",
  "post_id": "01HV0CONTENTPOST0000000001",
  "summary": "Strong fit for hands-on developer communities; lead with the concrete result rather than the product name.",
  "recommendations": [
    {
      "channel": "reddit r/webdev",
      "action": "promote",
      "priority": "high",
      "rationale": "The piece is a hands-on tutorial and r/webdev rewards practical write-ups; you haven't shared it there yet.",
      "suggested_message": "Wrote up how I cut our build times 40% with a few config tweaks — happy to answer questions on the approach."
    },
    {
      "channel": "dev.to",
      "action": "cross_post",
      "priority": "medium",
      "rationale": "Long-form republish reaches a developer audience; set a canonical URL back to the original to avoid duplicate-content issues.",
      "suggested_message": "Cross-posting my latest deep dive — full walkthrough with code."
    }
  ],
  "already_covered": ["x", "linkedin"],
  "generated_at": "2026-06-01T14:30:00.000Z"
}
```

---

### GET /campaigns/{campaignId}/content-posts/{postId}/recommendations

Return the most recently generated recommendation set for the content post.

**Authentication:** Cognito.

**Responses:**

- `200 OK` - [EngagementRecommendation](#engagementrecommendation-object).
- `404 Not Found` - no recommendations have been generated for this post yet.
- `500 Internal Server Error`.

---

## Content

Content is the app's central object: a piece a creator makes (a blog post,
social post, or video), sponsored or not. Everything is tenant-scoped under the
signed-in creator's partition. The catalog is unified — the retired Blogs
surface's legacy `Blog`-only rows are merged into these reads, and a campaign
(sponsorship) optionally hangs off a piece 1:1.

All routes require Cognito authentication and resolve the tenant from the token.

### GET /content

List the creator's content, newest first. Merges unified content with any
legacy blog-only rows (content wins on id collision). Because it merges two
sources, it is unpaginated (`nextStartKey` is always `null`); pass `?limit=` to
trim. `?type=`, `?source=`, and `?status=` filter the merged set.

- `200 OK` — `{ "content": [ContentSummary...], "nextStartKey": null }`.

### POST /content

Create a piece of content.

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `type` | enum | yes | `blog` \| `social` \| `video` |
| `title` | string | yes | <=300 chars |
| `slug` | string | yes | kebab-case, <=200 chars |
| `content_markdown` | string | yes | the body, <=300000 chars |
| `source` | enum | no | `owned` \| `sponsored` (default `owned`) |
| `status` | enum | no | `draft` \| `scheduled` \| `published` \| `archived` (default `draft`) |
| `description` | string | no | <=1000 chars |
| `tags`, `categories` | string[] | no | <=30 entries |
| `canonical_url` | string | no | http(s) |
| `publish_date` | string | no | `YYYY-MM-DD`; the calendar anchor |
| `campaign_id` | string | no | attach a sponsorship at creation (must exist, 1:1) |

- `201 Created` — [Content](#content-object). `409 Conflict` if the campaign is
  already attached elsewhere; `404` if it doesn't exist.

### GET /content/{contentId}

Get a single piece. Falls back to a legacy blog row when no content row exists.
Adds two backing flags: `content_backed` (a real content row exists — so status
edits, sponsorship, and the primary delete apply) and `blog_backed` (a legacy
blog row exists — so cross-post, which reads the blog entity, works).

- `200 OK` — [Content](#content-object) plus `content_backed` / `blog_backed`.

### PATCH /content/{contentId}

Update editable fields (`title`, `slug`, `type`, `source`, `status`,
`description`, `content_markdown`, `tags`, `categories`, `canonical_url`,
`publish_date`). A `null` clears a clearable field. `campaign_id` is routed
through attach/detach (a `null` detaches) rather than a plain write.

### DELETE /content/{contentId}

Delete a piece and its children. Falls back to deleting a legacy blog row when
there is no content row. `204 No Content`.

### POST /content/ask

RAG Q&A grounded in the creator's content catalog. Body `{ question, top_k?,
content_id?, type? }`; returns `{ answer, confidence, sources[] }`.

### Sponsorship (campaign hanging off a piece)

A piece owns at most one campaign (1:1, optional).

- `GET /content/{contentId}/campaign` — the attached [Campaign](#campaign-object), or `404`.
- `PUT /content/{contentId}/campaign` — attach an existing campaign; body `{ campaign_id }`. `409` if either side is already linked.
- `POST /content/{contentId}/campaign` — create a campaign and attach it in one step (body is a [CreateCampaignRequest](#createcampaignrequest)). `409` if the piece is already sponsored.
- `DELETE /content/{contentId}/campaign` — detach; the campaign survives. `204`.

### Publishing & analytics

Content-level distribution and performance, independent of any campaign.

- `POST /content/{contentId}/publish` — record where a piece went live; body `{ platform, url?, published_at?, notes? }` (`platform` is a free-form slug). One row per platform.
- `GET /content/{contentId}/publish` — the publish variants.
- `PUT /content/{contentId}/stats/{platform}` — record a metric snapshot for the current UTC day; body `{ metrics: { name: number, ... }, captured_at? }`.
- `GET /content/{contentId}/analytics` — `{ publish_variants[], stats: [{ platform, snapshots[] }] }`.

### POST /content/{contentId}/crosspost

Cross-post a content piece to dev.to / Medium / Hashnode, publishing
synchronously off the content row (so content-native pieces can cross-post).
Body `{ platforms: ["dev"|"medium"|"hashnode", ...] }`. Each success is recorded
as a publish variant; platforms already published are skipped. Returns
`{ content_id, results: [{ platform, status, url?, error? }] }`.

---

## Voice

Per-tenant, per-platform writing-style learning and synthesis. The voice is
learned from your published posts, weighted toward the most recently published
work by an exponential publish-date decay (see
[`docs/voice-recency.md`](voice-recency.md)). Published blog content is captured
automatically; short-form samples are captured explicitly. `platform` is one of
`blog`, `x`, `linkedin`, `bluesky`, `instagram`, `threads`, `mastodon`,
`medium`, `devto`; `format` is `social` or `blog` (`blog` platform pins
`blog`).

### GET /voice/overview

The flagship read. For every platform the tenant has a profile on: the
plain-English `portrait`, and corpus transparency. One call powers the voice
dashboard.

- `200 OK` — `{ platforms: [{ platform, portrait, version, samples_since_reflection, reflection_threshold, recency_half_life_days, updated_at, corpus }] }`.
- `corpus` = `{ total_samples, by_source: { source: count }, earliest_published, latest_published, recent_influence: [{ window_days, influence_share, sample_count }] }`.
- `recent_influence[n].influence_share` is the fraction (0-1) of the current voice that comes from posts published within `window_days` — the recency weighting made legible.

### POST /voice/compose

Draft a post in the tenant's voice. Body `{ topic, platform, format, guidance? }`.
Retrieves a recency-ranked set of past posts as few-shot examples plus the
learned profile. Returns `{ post, title }` (not persisted). A streaming variant
is served by the compose Function URL.

### POST /voice/check

Grade an arbitrary draft against the learned voice (paste-and-score). Body
`{ draft, platform, format }`. Runs the same recency-weighted retrieval as
compose but assesses instead of writing.

- `200 OK` — `{ score, verdict, summary, strengths[], issues: [{ area, detail, suggestion }], on_voice_rewrite }`.
- `score` is 0-100; `verdict` is `on_voice` (>=80) \| `close` (50-79) \| `off_voice` (<50). Judges style, not topic.

### POST /voice/samples

Capture a writing sample (manual paste, or "save" a generated draft). Body
`{ text, platform, format, source?, published_at? }`. `published_at` (a
`YYYY-MM-DD` date or ISO 8601 timestamp) anchors the sample on the recency
curve; it defaults to capture time. Style learning happens asynchronously off
the DynamoDB stream. `201 Created` — the [voice sample](#voice-sample).

### GET /voice/samples?platform=

Recent samples for a platform, newest first by recency anchor. Each is
annotated with `influence_share` — its current share (0-1) of the voice, the
recency weight it carries in reflection normalized over the eligible corpus.
Muted and generated samples report 0. `200 OK` — `{ samples: [voice sample] }`.

### PATCH /voice/samples/{id}?platform=

Mute or unmute a sample. Body `{ muted: boolean }`. Muting keeps the row (so
it's visible and reversible) but drops its vector and excludes it from
reflection, so it no longer drives the voice — and for an auto-captured post it
is durable (a later edit won't re-capture a muted sample). Unmuting re-embeds
it. The profile is re-derived immediately. `200 OK` — the updated
[voice sample](#voice-sample).

### DELETE /voice/samples/{id}?platform=

Remove a sample row and its vector, then re-derive the profile. For an
auto-captured post prefer PATCH `muted:true` — delete is not durable (a later
edit re-captures it), whereas muting sticks. `204 No Content`.

### GET /voice/profiles

Every per-platform profile for the tenant. `200 OK` — `{ profiles: [voice profile] }`.

### GET /voice/profiles/{platform}

One profile plus its reflection history (each reflection snapshots the profile
version + portrait, so the list reads as "your voice over time"). `200 OK` —
`{ profile, reflections: [{ reflection_id, change_summary, sample_window, half_life_days, version, portrait, model, created_at }] }`.

### PUT /voice/profiles/{platform}/steering

Set (or clear with `note: null`) the steering note — a short "what I'm going
for lately" (<=500 chars) that biases the next reflection toward where the
creator is taking their voice. Re-derives the profile immediately so the steer
takes effect. `200 OK` — `{ profile }`.

### POST /voice/profiles/{platform}/reflect

Re-derive the profile now from recent samples (the same path the stream runs
automatically every `ReflectionThreshold` samples). Muted and generated samples
are excluded — only authored/published work defines the voice. `200 OK` —
`{ profile }`.

A **voice profile** is `{ platform, profile, portrait, steering,
samples_since_reflection, reflection_threshold, recency_half_life_days, version,
created_at, updated_at }` where `profile` is the structured style JSON (`tone`,
`vocabulary`, `signature_phrases`, `dos`, `donts`, `portrait`, …), top-level
`portrait` is that JSON's plain-English summary, and `steering` is the
creator's intent note. A **voice sample** is `{ sample_id, platform, format,
source, text, published_at, created_at, muted, influence_share }`.

---

## Revenue

### GET /revenue

Aggregate campaign payouts. Splits totals into `booked` (amount on the
campaign regardless of payment state) and `received` (campaigns where
`payout.paid = true`). Returns per-bucket subtotals via `groups`.

**Authentication:** Cognito.

**Query parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `year` | integer | Calendar year, 1900-2999. Defaults to current year. Mutually exclusive with `startDate`/`endDate` |
| `startDate` | string (date) | ISO 8601 inclusive. Mutually exclusive with `year` |
| `endDate` | string (date) | ISO 8601 inclusive. Mutually exclusive with `year` |
| `vendorId` | string | ULID. Scopes the rollup to one vendor |
| `grouping` | enum | `year` \| `month` \| `vendor`. Default `month` |
| `paidOnly` | boolean | Default `false`. When `true`, excludes campaigns where `payout.paid` is not `true` |

**Responses:**

- `200 OK` - [RevenueResponse](#revenueresponse-object).
- `400 Bad Request` - validation failure (for example invalid date
  format or mutually exclusive params both present).
- `500 Internal Server Error`.

Group key shape depends on `grouping`:

- `month` (default): `YYYY-MM`.
- `year`: `YYYY`.
- `vendor`: the vendor's ULID, or the literal string `unassigned` for
  campaigns with no `vendor_id`.

Today's aggregation is denominated in USD; payouts in other currencies
are returned via the `skipped` array with a reason.

Example success body (grouping=month):

```json
{
  "currency": "USD",
  "range": {
    "startDate": "2026-01-01",
    "endDate": "2026-12-31"
  },
  "total": { "amount": 12500, "campaignCount": 6 },
  "booked": { "amount": 12500, "campaignCount": 6 },
  "received": { "amount": 7500, "campaignCount": 3 },
  "groups": [
    {
      "key": "2026-05",
      "amount": 5000,
      "campaignCount": 2,
      "bookedAmount": 5000,
      "bookedCount": 2,
      "receivedAmount": 2500,
      "receivedCount": 1
    }
  ],
  "skipped": [
    {
      "campaign_id": "01HZX7P1F0Q3WJX5T2J9C8R6XY",
      "currency": "EUR",
      "amount": 1800,
      "reason": "non-USD currency"
    }
  ]
}
```

---

## Insights

Account-wide Trends & Insights over the creator's tracked content. Read-side
aggregation over the daily engagement snapshots already captured for social
and content posts — no new data is written.

### GET /insights

Roll up cumulative engagement levels across every tracked post into a daily
time series, top-performing posts, a per-platform split, and
period-over-period deltas.

**Authentication:** Cognito.

**Query parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `startDate` | string (date) | ISO 8601 inclusive. Both-or-neither with `endDate`. Defaults to 90 days ago |
| `endDate` | string (date) | ISO 8601 inclusive. Defaults to today. Range capped at 730 days |

**Responses:**

- `200 OK` - [InsightsResponse](#insightsresponse-object).
- `400 Bad Request` - only one of `startDate`/`endDate` given, malformed/invalid date, inverted range, or range over 730 days.
- `500 Internal Server Error`.

Notes:

- Snapshots are **cumulative levels** (each day is a post's running total as
  of that day). The series carries the last known level forward across days
  with no capture rather than zero-filling, so it's robust to irregular
  extension capture. Clients derive day-over-day deltas from it.
- `deltas` compares the engagement *gained* in the window against the
  immediately preceding window of equal length. `changePct` is `null` when
  the prior window had no gain to compare against.
- `topPosts[].lastCaptured` is the date of the post's most recent snapshot —
  surfaces stale data so a flat trend can be read as "not captured" rather
  than "no activity".

Example success body (abbreviated):

```json
{
  "range": { "startDate": "2026-03-02", "endDate": "2026-05-31", "days": 91 },
  "totals": {
    "views": 120000, "impressions": 80000, "engagements": 9500,
    "reach": 200000, "engagementRate": 0.0475, "postsTracked": 24
  },
  "deltas": {
    "thisPeriod": { "views": 30000, "impressions": 20000, "engagements": 2400 },
    "priorPeriod": { "views": 25000, "impressions": 18000, "engagements": 2000 },
    "changePct": { "views": 0.2, "impressions": 0.111, "engagements": 0.2 }
  },
  "timeseries": [
    { "date": "2026-03-02", "views": 90000, "impressions": 60000, "engagements": 7100 }
  ],
  "topPosts": [
    {
      "platform": "x", "kind": "social", "url": "https://x.com/you/status/1",
      "campaignId": "01HZ...", "campaignName": "Q3 Launch",
      "views": 12000, "impressions": 0, "engagements": 850,
      "lastCaptured": "2026-05-30"
    }
  ],
  "byPlatform": [
    { "platform": "x", "views": 60000, "impressions": 0, "engagements": 5200 }
  ]
}
```

---

## Profile

The single shared account profile. It carries two concerns: **integration
settings** (Google Analytics 4 and Core Web Vitals, used by
[web analytics](#get-campaignscampaignidweb-analytics)) and the
**creator profile** that the [media kit](#media-kit) and shared reports
render from — identity, social accounts, audience, rate card, testimonials,
and featured collaborations. This stack is effectively single-tenant, so
there is one shared profile rather than one per user. Secrets (the GA4
service account and the CrUX API key) are stored in SSM SecureStrings and
are **never returned** — responses only report whether each integration is
configured.

### GET /profile

Read the full profile.

**Authentication:** Cognito.

**Responses:**

- `200 OK` - [Profile](#profile-object).
- `500 Internal Server Error`.

Example success body:

```json
{
  "brand": { "name": "Ready, Set, Cloud!", "website_url": "https://readysetcloud.io" },
  "personal_site_url": "https://www.readysetcloud.io",
  "identity": {
    "display_name": "Allen Helton",
    "tagline": "Serverless educator & developer advocate",
    "bio": "I teach cloud and serverless.",
    "location": "Tennessee, USA",
    "contact_email": "partnerships@readysetcloud.io",
    "accent_color": "#2256c7",
    "niches": ["AWS", "Serverless"],
    "avatar_key": "profile/avatar-01J0A2B3C4D5E6F7G8H9JKMNPQ.png",
    "avatar_url": "https://reports.example.com/profile/avatar-...png?Expires=...",
    "logo_key": null,
    "logo_url": null
  },
  "social_accounts": [
    { "platform": "x", "handle": "@allenheltondev", "url": null, "followers": 12000 }
  ],
  "audience": {
    "ageBrackets": { "25-34": 45, "35-44": 30 },
    "gender": { "male": 70, "female": 30 },
    "topCountries": [{ "country": "United States", "percent": 55 }],
    "note": "Mostly senior developers and architects"
  },
  "rate_card": [
    { "deliverable": "Sponsored blog post", "description": null, "price": 2500, "currency": "USD" }
  ],
  "testimonials": [
    { "quote": "A pleasure to work with.", "author": "Jordan Lee", "role": "Marketing Lead", "company": "Acme" }
  ],
  "featured_collaborations": [
    { "brand": "Acme Corp", "description": "Q3 launch campaign", "url": "https://acme.example", "year": 2025 }
  ],
  "ga4": {
    "property_id": "123456789",
    "service_account_email": "booked@my-project.iam.gserviceaccount.com",
    "configured": true
  },
  "core_web_vitals": { "configured": true },
  "updated_at": "2026-05-27T14:03:11.512Z"
}
```

### PUT /profile

Store profile fields. The GA4 service account and CrUX API key are written to
SSM SecureStrings; everything else is stored in DynamoDB. All fields are
optional — only those present are applied (partial update). For the nullable
creator fields, an explicit `null` clears the field; arrays replace the prior
value wholesale. The response is the same shape as `GET /profile` and never
echoes the secrets back.

**Authentication:** Cognito.

**Request body** (all fields optional):

| Field | Type | Notes |
| --- | --- | --- |
| `ga4_property_id` | string | Numeric GA4 property id (e.g. `123456789`) |
| `ga4_service_account` | string | The Google service-account JSON key, as a string (contents of the downloaded key file). The service account needs Viewer on the GA4 property |
| `crux_api_key` | string | A Google API key with the CrUX API and PageSpeed Insights API enabled. <=200 chars |
| `brand_name` | string | <=80 chars. Shown on shared reports |
| `website_url` | string | <=200 chars. Bare host accepted (https assumed). Brand site shown on shared reports |
| `personal_site_url` | string | <=200 chars. Bare host accepted (https assumed). The creator's own site; content posts published here have their prebuilt plaintext (`<url>/index.txt`) pulled for [recommendations](#content-post-recommendations) |
| `display_name` | string \| null | <=80 chars |
| `tagline` | string \| null | <=160 chars |
| `bio` | string \| null | <=2000 chars |
| `location` | string \| null | <=120 chars |
| `contact_email` | string \| null | Valid email, <=320 chars |
| `accent_color` | string \| null | Hex color (`#abc` or `#aabbcc`) |
| `public_slug` | string \| null | Vanity slug for the public media kit (`^[a-z0-9-]{3,40}$`, no leading/trailing/double hyphen) |
| `niches` | array of string \| null | <=20 items, each <=40 chars, deduped |
| `avatar_key` | string \| null | A key returned by [`POST /profile/images/upload-url`](#post-profileimagesupload-url) with `kind=avatar` |
| `logo_key` | string \| null | A key returned by the upload endpoint with `kind=logo` |
| `social_accounts` | array \| null | <=30 items. Each `{ platform, handle?, url?, followers? }`; needs a handle or url |
| `audience` | object \| null | `{ ageBrackets?, gender?, topCountries?, note? }`; percentages 0-100 |
| `rate_card` | array \| null | <=30 items. Each `{ deliverable, description?, price?, currency? }` (currency defaults `USD`) |
| `testimonials` | array \| null | <=20 items. Each `{ quote, author?, role?, company? }` |
| `featured_collaborations` | array \| null | <=20 items. Each `{ brand, description?, url?, year? }` |

Example request:

```json
{
  "display_name": "Allen Helton",
  "tagline": "Serverless educator",
  "niches": ["AWS", "Serverless"],
  "social_accounts": [
    { "platform": "x", "handle": "@allenheltondev", "followers": 12000 }
  ],
  "rate_card": [
    { "deliverable": "Sponsored blog post", "price": 2500, "currency": "USD" }
  ]
}
```

**Responses:**

- `200 OK` - updated [Profile](#profile-object).
- `400 Bad Request` - validation failure (non-numeric property id, malformed service account JSON, bad email/color/url, over-limit field, unknown image key).
- `500 Internal Server Error`.

### POST /profile/images/upload-url

Mint a presigned S3 `PUT` URL for a profile image (avatar or logo). The
client uploads the image bytes directly to the returned `url` (bound to the
`content_type`), then persists the returned `key` via
[`PUT /profile`](#put-profile) as `avatar_key` or `logo_key`. Images are
stored in the private reports bucket and surfaced on the media kit via
long-lived CloudFront signed URLs.

**Authentication:** Cognito.

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | enum | yes | `avatar` \| `logo` |
| `content_type` | enum | yes | `image/png` \| `image/jpeg` \| `image/webp` \| `image/gif` |

**Responses:**

- `200 OK` - `{ "kind": "avatar", "key": "profile/avatar-...png", "url": "https://...", "expiresAt": "..." }`. The presigned `url` is valid for 15 minutes.
- `400 Bad Request` - unknown `kind` or unsupported `content_type`.
- `500 Internal Server Error`.

---

## Media kit

A shareable, brand-facing one-pager built from the [creator profile](#profile)
plus live aggregate performance across every campaign (total followers,
cross-campaign reach and engagement, campaigns delivered). Rendered to a
standalone HTML page, stored in the private reports bucket, and served via a
CloudFront signed URL — the same delivery pattern as
[campaign reports](#campaign-reports). Reports age out after the retention
window (90 days by default).

### POST /media-kit

Generate a fresh media kit. Builds the snapshot, renders the HTML (with the
avatar/logo image URLs signed for the kit's full lifetime), stores it,
persists a record, and returns a signed share link plus a minted short link.

**Authentication:** Cognito.

**Responses:**

- `201 Created` - [MediaKitGenerateResult](#mediakitgenerateresult-object).
- `500 Internal Server Error`.

Example success body:

```json
{
  "reportId": "01J0A2B3C4D5E6F7G8H9JKMNPQ",
  "url": "https://reports.example.com/reports/media-kit/01J0...html?Expires=...",
  "shortUrl": "https://rdyset.click/c/Mk7Qz2",
  "expiresAt": "2026-08-29T14:03:11.512Z",
  "dataAsOf": "2026-05-31",
  "stats": {
    "totalFollowers": 15000,
    "platformCount": 2,
    "campaignsCompleted": 6,
    "campaignsTotal": 8,
    "postsTracked": 24,
    "totalViews": 120000,
    "totalImpressions": 80000,
    "totalReach": 200000,
    "totalEngagements": 9500,
    "engagementRate": 0.0475
  }
}
```

### GET /media-kit

List previously-generated media kits, newest first, each with a freshly
re-signed link valid for as long as its S3 object survives. Records whose
object has already aged out are skipped.

**Authentication:** Cognito.

**Responses:**

- `200 OK` - `{ "media_kits": [MediaKitListItem, ...] }`.
- `500 Internal Server Error`.

Each item is `{ reportId, generatedAt, dataAsOf, stats, url, expiresAt }`,
where `stats` is the [MediaKitStats](#mediakitstats-object) snapshot frozen at
generation time.

### Public media kit

The endpoints above mint **private, signed, expiring** links for targeted
brand sends. The endpoints below manage the **public** media kit: a permanent,
brand-facing teaser published to a stable vanity URL (`https://<public-host>/<slug>`)
that anyone can view — the inbound front door. It is served anonymously from a
dedicated public bucket/CloudFront distribution (separate from the signed
report bucket), is **search-engine indexable**, and deliberately **omits the
rate card** (pricing stays in the private link). Generating and publishing are
still fully Cognito-gated; only the resulting static page is public. Requires a
`public_slug` set via [`PUT /profile`](#put-profile).

The public page is built for discovery and sharing: the renderer
server-renders the `<head>` with a title, meta description, canonical link,
Open Graph + Twitter card tags (so the link unfurls with the creator's avatar
in Slack/LinkedIn/X), and a `ProfilePage`/`Person` JSON-LD block. Publishing
also writes `robots.txt` and `sitemap.xml` at the public bucket root pointing
crawlers at the page; unpublishing removes them. Private signed kits stay
`noindex` with none of this head metadata.

#### POST /media-kit/publish

Render the public teaser from the current profile + aggregate stats, copy the
avatar/logo into the public bucket (so the permanent page has permanent image
URLs), write the page to the slug, and mark the profile published. Republishing
overwrites in place to refresh the data.

**Authentication:** Cognito.

**Responses:**

- `200 OK` - `{ "slug": "...", "url": "https://...", "published": true, "published_at": "..." }`.
- `400 Bad Request` - no `public_slug` set on the profile.
- `500 Internal Server Error`.

#### DELETE /media-kit/publish

Take the public page down (removes the page + copied images) and clear the
published flag. Idempotent — unpublishing when nothing is published is a
no-op success.

**Authentication:** Cognito.

**Responses:**

- `204 No Content`.

#### GET /media-kit/publish

Report the current public-kit state.

**Authentication:** Cognito.

**Responses:**

- `200 OK` - `{ "slug": string | null, "published": boolean, "url": string | null, "published_at": string | null }`.

---

## Vendors

### POST /vendors

Create a vendor.

**Authentication:** Cognito.

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | 1-200 chars |
| `website` | string | no | <=500 chars |
| `contact_name` | string | no | <=200 chars |
| `contact_email` | string (email) | no | <=320 chars |
| `payment_terms` | string | no | <=500 chars; free-form notes |
| `tags` | array of string | no | <=20 items, each 1-50 chars |
| `notes` | string | no | <=2000 chars |

Example:

```json
{
  "name": "Acme Corp",
  "website": "https://acme.example",
  "contact_name": "Jordan Lee",
  "contact_email": "jordan@acme.example",
  "payment_terms": "net 30",
  "tags": ["enterprise", "saas"]
}
```

**Responses:**

- `201 Created` - [Vendor](#vendor-object).
- `400 Bad Request` - validation failure.
- `500 Internal Server Error`.

---

### GET /vendors

List vendors, paginated.

**Authentication:** Cognito.

**Query parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `limit` | integer | 1-500. Default 100 |
| `startKey` | string | Base64-encoded pagination token returned as `nextStartKey` on the prior page |

**Responses:**

- `200 OK` - [VendorList](#vendorlist-object).
- `400 Bad Request` - validation failure.
- `500 Internal Server Error`.

Example success body:

```json
{
  "vendors": [
    {
      "vendor_id": "01HZX7M6Z5GQK6T7Q8N9R0P1V2",
      "name": "Acme Corp",
      "website": "https://acme.example",
      "contact_name": "Jordan Lee",
      "contact_email": "jordan@acme.example",
      "payment_terms": "net 30",
      "tags": ["enterprise", "saas"],
      "notes": null,
      "created_at": "2026-04-12T10:11:00.000Z",
      "updated_at": "2026-04-12T10:11:00.000Z"
    }
  ],
  "nextStartKey": null
}
```

---

### GET /vendors/{vendorId}

Get a vendor by ID.

**Authentication:** Cognito.

**Path parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `vendorId` | string (ULID) | `^[0-9A-HJKMNP-TV-Z]{26}$` |

**Responses:**

- `200 OK` - [Vendor](#vendor-object).
- `404 Not Found` - vendor does not exist.
- `500 Internal Server Error`.

---

### PUT /vendors/{vendorId}

Partial update of a vendor. Only fields present in the body are touched.
Explicit `null` clears an optional field. The `name` field cannot be
cleared.

**Authentication:** Cognito.

**Path parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `vendorId` | string (ULID) | `^[0-9A-HJKMNP-TV-Z]{26}$` |

**Request body** (all fields optional):

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `name` | string | no | 1-200 chars |
| `website` | string | yes | <=500 chars |
| `contact_name` | string | yes | <=200 chars |
| `contact_email` | string (email) | yes | <=320 chars |
| `payment_terms` | string | yes | <=500 chars |
| `tags` | array of string | yes | <=20 items, each 1-50 chars |
| `notes` | string | yes | <=2000 chars |

Example request:

```json
{
  "payment_terms": "net 45",
  "notes": null
}
```

**Responses:**

- `200 OK` - updated [Vendor](#vendor-object).
- `400 Bad Request` - validation failure.
- `404 Not Found` - vendor does not exist.
- `500 Internal Server Error`.

---

### DELETE /vendors/{vendorId}

Delete a vendor. Fails with `409` if any campaigns are linked to the
vendor; unlink or delete those campaigns first.

**Authentication:** Cognito.

**Path parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `vendorId` | string (ULID) | `^[0-9A-HJKMNP-TV-Z]{26}$` |

**Responses:**

- `204 No Content` - vendor deleted.
- `404 Not Found` - vendor does not exist.
- `409 Conflict` - vendor has linked campaigns.
- `500 Internal Server Error`.

---

### GET /vendors/{vendorId}/campaigns

List campaigns linked to a vendor. Reads from the campaign-by-vendor
index entries written when a campaign is created with a `vendor_id`.

**Authentication:** Cognito.

**Path parameters:**

| Name | Type | Notes |
| --- | --- | --- |
| `vendorId` | string (ULID) | `^[0-9A-HJKMNP-TV-Z]{26}$` |

**Responses:**

- `200 OK` - [VendorCampaignList](#vendorcampaignlist-object). Items
  are [VendorCampaignSummary](#vendorcampaignsummary-object) (a subset
  of the full Campaign).
- `404 Not Found` - vendor does not exist.
- `500 Internal Server Error`.

Example success body:

```json
{
  "vendor_id": "01HZX7M6Z5GQK6T7Q8N9R0P1V2",
  "campaigns": [
    {
      "campaign_id": "01HZX7P1F0Q3WJX5T2J9C8R6KT",
      "name": "Q3 Launch with Acme",
      "status": "active",
      "startDate": "2026-07-01",
      "endDate": "2026-09-30",
      "created_at": "2026-05-22T14:03:11.512Z"
    }
  ]
}
```

---

## Planned endpoints

The following routes are referenced in open issues and are not part of
the currently merged API surface. They are documented here for context
only.

- `GET /campaigns` - list campaigns. Tracked in issue
  [#9](https://github.com/allenheltondev/content-tracking/issues/9).
- `PUT /campaigns/{campaignId}/links/{linkId}` and
  `DELETE /campaigns/{campaignId}/links/{linkId}` - mutate or remove a
  registered link. Tracked in issue
  [#10](https://github.com/allenheltondev/content-tracking/issues/10).

This document will be updated when those routes are merged into
`publicapi.yaml`.

---

## Schemas

### Campaign object

| Field | Type | Notes |
| --- | --- | --- |
| `campaign_id` | string | Server-generated identifier |
| `name` | string | |
| `sponsor` | string \| null | Legacy free-form sponsor |
| `vendor_id` | string \| null | ULID if set |
| `startDate` | string (date) \| null | |
| `endDate` | string (date) \| null | |
| `status` | enum | `draft` \| `active` \| `completed` |
| `targetMetrics` | object \| null | |
| `payout` | [Payout](#payout-object) \| null | |
| `blog_url` | string (uri) \| null | Published blog post URL, or `null` |
| `created_at` | string (date-time) | |

### Payout object

| Field | Type | Notes |
| --- | --- | --- |
| `amount` | number | `>= 0`. Required |
| `currency` | string | ISO 4217 alphabetic code (`^[A-Z]{3}$`). Default `USD`. Only USD aggregates in `GET /revenue` today |
| `paid` | boolean | Default `false` |
| `paid_at` | string (date) \| null | |
| `invoice_ref` | string \| null | <=200 chars |

### Link object

| Field | Type | Notes |
| --- | --- | --- |
| `campaign_id` | string | |
| `link_id` | string | |
| `code` | string | Exactly 6 chars (minted by newsletter-service) |
| `short_url` | string | |
| `role` | enum | `main` \| `cross_post` \| `social_promo` |
| `platform` | string | |
| `url` | string | |
| `src` | string \| null | |
| `notes` | string \| null | |
| `expires_at` | string (date-time) | |
| `created_at` | string (date-time) | |

### SocialPost object

| Field | Type | Notes |
| --- | --- | --- |
| `campaign_id` | string | |
| `post_id` | string | ULID |
| `platform` | enum | `twitter` \| `linkedin` \| `instagram` |
| `url` | string | The post's public URL |
| `notes` | string \| null | |
| `analytics` | object<string,number> \| null | Captured engagement, e.g. `{ "likes": 50, "reposts": 7 }`. `null` until first capture |
| `last_fetched` | string (date-time) \| null | Server timestamp of the most recent analytics write |
| `captured_at` | string (date-time) \| null | Client-observed timestamp of the most recent metrics |
| `created_at` | string (date-time) | |
| `updated_at` | string (date-time) \| null | |

The `GET /social-posts/active` feed returns the same shape with an
additional `campaign_name` field.

### Draft object

| Field | Type | Notes |
| --- | --- | --- |
| `url` | string | The draft's link (almost always a Google Doc) |
| `doc_id` | string \| null | Google Docs document id when the link is a Google Doc; `null` otherwise |
| `review` | [DraftReview](#draftreview-object) \| null | Latest AI review; `null` until reviewed (and reset when the link changes) |
| `reviewed_at` | string (date-time) \| null | When the review was generated |
| `created_at` | string (date-time) | |
| `updated_at` | string (date-time) | |

### DraftReview object

| Field | Type | Notes |
| --- | --- | --- |
| `verdict` | enum | `ready` \| `minor_revisions` \| `major_revisions` |
| `summary` | string | One-paragraph overall assessment |
| `brief_alignment` | string | How well the draft fulfills the brief |
| `strengths` | array<string> | What the draft does well |
| `issues` | array | Actionable problems (see fields below) |
| `issues[].severity` | enum | `high` \| `medium` \| `low` |
| `issues[].area` | string | `brief-coverage`, `structure`, `tone`, `accuracy`, `clarity`, `cta`, `seo`, ... |
| `issues[].detail` | string | What's wrong |
| `issues[].suggestion` | string | How to fix it |
| `missing_requirements` | array<string> | Brief requirements the draft doesn't address |

### EngagementRecommendation object

| Field | Type | Notes |
| --- | --- | --- |
| `campaign_id` | string | |
| `post_id` | string | The content post these recommendations are for |
| `summary` | string \| null | One- or two-sentence overall distribution strategy |
| `recommendations` | array | Where to cross-post or promote, strongest first (see fields below) |
| `recommendations[].channel` | string | The platform or venue (e.g. `linkedin`, `reddit r/webdev`, `hacker news`) |
| `recommendations[].action` | enum | `cross_post` (republish the full piece) \| `promote` (share a link/teaser) |
| `recommendations[].priority` | enum | `high` \| `medium` \| `low` |
| `recommendations[].rationale` | string | Why this channel fits and extends reach |
| `recommendations[].suggested_message` | string | Ready-to-use, channel-tailored copy with a fresh angle |
| `already_covered` | array<string> | Channels skipped because the piece is already there or already promoted on them |
| `generated_at` | string (date-time) | When this set was generated |

### LinkAnalytics object

| Field | Type | Notes |
| --- | --- | --- |
| `campaign_id` | string | |
| `link_id` | string | |
| `code` | string | |
| `role` | string | |
| `platform` | string | |
| `url` | string | |
| `analytics` | object | Per-link rollup from newsletter-service |
| `analytics.code` | string | |
| `analytics.total_clicks` | integer | |
| `analytics.by_day` | object<string,integer> | Day key → click count |
| `analytics.by_src` | object<string,integer> | Source label → click count |
| `analytics.first_click_at` | string (date-time) \| null | |
| `analytics.last_click_at` | string (date-time) \| null | |

### CampaignAnalytics object

| Field | Type | Notes |
| --- | --- | --- |
| `campaign_id` | string | |
| `link_count` | integer | `>= 0` |
| `total_clicks` | integer | `>= 0`. Excludes clicks from links whose upstream analytics call failed |
| `by_role` | object<string,integer> | Role → total clicks |
| `by_platform` | object<string,integer> | Platform → total clicks |
| `upstream_failures` | integer | Count of per-link analytics calls that failed |
| `links` | array | Per-link rollup (see fields below) |
| `links[].link_id` | string | |
| `links[].code` | string | |
| `links[].role` | string | |
| `links[].platform` | string | |
| `links[].url` | string | |
| `links[].total_clicks` | integer | |
| `links[].first_click_at` | string (date-time) \| null | |
| `links[].last_click_at` | string (date-time) \| null | |
| `links[].error` | string \| null | Non-null when the per-link analytics fetch failed |

### Vendor object

| Field | Type | Notes |
| --- | --- | --- |
| `vendor_id` | string (ULID) | |
| `name` | string | |
| `website` | string \| null | |
| `contact_name` | string \| null | |
| `contact_email` | string \| null | |
| `payment_terms` | string \| null | |
| `tags` | array of string | |
| `notes` | string \| null | |
| `created_at` | string (date-time) | |
| `updated_at` | string (date-time) | |

### VendorList object

| Field | Type | Notes |
| --- | --- | --- |
| `vendors` | array of [Vendor](#vendor-object) | |
| `nextStartKey` | string \| null | Base64-encoded pagination token. `null` when there are no more pages |

### VendorCampaignSummary object

| Field | Type | Notes |
| --- | --- | --- |
| `campaign_id` | string | |
| `name` | string | |
| `status` | enum | `draft` \| `active` \| `completed` |
| `startDate` | string (date) \| null | |
| `endDate` | string (date) \| null | |
| `created_at` | string (date-time) | |

### VendorCampaignList object

| Field | Type | Notes |
| --- | --- | --- |
| `vendor_id` | string | |
| `campaigns` | array of [VendorCampaignSummary](#vendorcampaignsummary-object) | |

### RevenueResponse object

| Field | Type | Notes |
| --- | --- | --- |
| `currency` | string | `USD` today |
| `range.startDate` | string (date) \| null | Inclusive lower bound used for the rollup |
| `range.endDate` | string (date) \| null | Inclusive upper bound used for the rollup |
| `total` | [RevenueAggregate](#revenueaggregate-object) | `booked` + `received` denominated in `currency` |
| `booked` | [RevenueAggregate](#revenueaggregate-object) | All campaigns in range |
| `received` | [RevenueAggregate](#revenueaggregate-object) | Campaigns with `payout.paid = true` |
| `groups` | array of [RevenueGroup](#revenuegroup-object) | Per-bucket subtotals |
| `skipped` | array of [RevenueSkipped](#revenueskipped-object) | Campaigns excluded from the aggregation |

### RevenueAggregate object

| Field | Type | Notes |
| --- | --- | --- |
| `amount` | number | |
| `campaignCount` | integer | |

### RevenueGroup object

| Field | Type | Notes |
| --- | --- | --- |
| `key` | string | Bucket key. `YYYY-MM` for `month`, `YYYY` for `year`, vendor ULID or `unassigned` for `vendor` |
| `amount` | number | |
| `campaignCount` | integer | |
| `bookedAmount` | number | |
| `bookedCount` | integer | |
| `receivedAmount` | number | |
| `receivedCount` | integer | |

### RevenueSkipped object

| Field | Type | Notes |
| --- | --- | --- |
| `campaign_id` | string | |
| `currency` | string | |
| `amount` | number | |
| `reason` | string | For example `non-USD currency` |

### Profile object

| Field | Type | Notes |
| --- | --- | --- |
| `brand.name` | string \| null | Brand name shown on shared reports |
| `brand.website_url` | string \| null | Brand website |
| `personal_site_url` | string \| null | The creator's own site; drives prebuilt-plaintext fetching for content recommendations |
| `identity.display_name` | string \| null | Creator's display name |
| `identity.tagline` | string \| null | Short one-line tagline |
| `identity.bio` | string \| null | Longer about paragraph |
| `identity.location` | string \| null | Free-form location |
| `identity.contact_email` | string \| null | Partnerships contact email |
| `identity.accent_color` | string \| null | Hex color applied to the media kit |
| `identity.niches` | array of string | Topic/niche tags |
| `identity.avatar_key` | string \| null | Stored avatar S3 key |
| `identity.avatar_url` | string \| null | Signed avatar preview URL; `null` if unset or signing unavailable |
| `identity.logo_key` | string \| null | Stored logo S3 key |
| `identity.logo_url` | string \| null | Signed logo preview URL |
| `social_accounts` | array | Each `{ platform, handle, url, followers }` |
| `audience` | object \| null | `{ ageBrackets, gender, topCountries, note }` |
| `rate_card` | array | Each `{ deliverable, description, price, currency }` |
| `testimonials` | array | Each `{ quote, author, role, company }` |
| `featured_collaborations` | array | Each `{ brand, description, url, year }` |
| `ga4.property_id` | string \| null | Numeric GA4 property id |
| `ga4.service_account_email` | string \| null | `client_email` from the stored service account |
| `ga4.configured` | boolean | True when both a property id and service account are stored |
| `core_web_vitals.configured` | boolean | True when a CrUX/PageSpeed API key is stored |
| `updated_at` | string (date-time) \| null | Last settings write |

### MediaKitStats object

| Field | Type | Notes |
| --- | --- | --- |
| `totalFollowers` | integer | Sum of follower counts across `social_accounts` |
| `platformCount` | integer | Number of social accounts |
| `campaignsCompleted` | integer | Campaigns with status `completed` |
| `campaignsTotal` | integer | All campaigns |
| `postsTracked` | integer | Social + content posts across all campaigns |
| `totalViews` | integer | Summed view-type metrics across tracked posts |
| `totalImpressions` | integer | Summed impression metrics |
| `totalReach` | integer | `totalViews + totalImpressions` |
| `totalEngagements` | integer | Summed engagement metrics (excludes views/impressions) |
| `engagementRate` | number \| null | `totalEngagements / totalReach`; `null` when there is no reach |

### MediaKitGenerateResult object

| Field | Type | Notes |
| --- | --- | --- |
| `reportId` | string (ULID) | Generated media-kit id |
| `url` | string | CloudFront signed URL, valid for the kit's full lifetime |
| `shortUrl` | string \| null | Minted short link wrapping `url`; `null` if minting failed |
| `expiresAt` | string (date-time) | When the kit (object + record) ages out |
| `dataAsOf` | string (date) | Date the snapshot was frozen |
| `stats` | [MediaKitStats](#mediakitstats-object) | Aggregate performance at generation time |

### WebAnalytics object

| Field | Type | Notes |
| --- | --- | --- |
| `campaign_id` | string | |
| `blog_url` | string | The campaign's blog post URL |
| `page_path` | string | Path portion of `blog_url`, used as the GA4 filter |
| `range.startDate` | string (date) | Inclusive lower bound of the GA4 query |
| `range.endDate` | string (date) | Inclusive upper bound of the GA4 query |
| `ga4` | object | GA4 section (see below) |
| `core_web_vitals` | object | Core Web Vitals section (see below) |
| `ga4.configured` | boolean | False when GA4 isn't set up |
| `ga4.error` | string \| null | Non-null when configured but the fetch failed |
| `ga4.property_id` | string | Present when configured and successful |
| `ga4.totals` | object | `pageviews`, `users`, `sessions` (integers); `avg_session_duration` (seconds), `engagement_rate`, `bounce_rate` (0-1) |
| `ga4.by_day` | object<string,integer> | Date (`YYYY-MM-DD`) → pageviews |
| `core_web_vitals.configured` | boolean | False when no CrUX/PageSpeed key is stored |
| `core_web_vitals.error` | string \| null | Non-null when configured but the fetch failed |
| `core_web_vitals.source` | enum | `crux` (real-user field data) or `psi` (PageSpeed Insights lab run) |
| `core_web_vitals.url` | string | URL the metrics describe |
| `core_web_vitals.strategy` | string | `psi` only (e.g. `mobile`) |
| `core_web_vitals.performance_score` | number \| null | `psi` only, 0-1 |
| `core_web_vitals.metrics` | object | `lcp_ms`, `cls`, `inp_ms`, `fcp_ms` (all nullable); `ttfb_ms` for `crux`, `tbt_ms` for `psi`. `inp_ms` is null for `psi` |

### InsightsResponse object

| Field | Type | Notes |
| --- | --- | --- |
| `range` | object | `{ startDate, endDate, days }` — the resolved window |
| `totals` | object | Cumulative `views`, `impressions`, `engagements`; plus `reach` (views+impressions), `engagementRate` (0-1 or null), `postsTracked` |
| `deltas.thisPeriod` | object | `{ views, impressions, engagements }` gained in the window |
| `deltas.priorPeriod` | object | Same shape, for the immediately preceding window of equal length |
| `deltas.changePct` | object | Per-metric fractional change vs. the prior period; each is `null` when the prior period had no gain |
| `timeseries` | array | Per-day `{ date, views, impressions, engagements }` cumulative levels, carried forward across capture gaps |
| `topPosts` | array | Posts ranked by engagement: `{ platform, kind, url, campaignId, campaignName, views, impressions, engagements, lastCaptured }` |
| `byPlatform` | array | Per-platform totals: `{ platform, views, impressions, engagements }` |
