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

- `200 OK` - `{ "campaign": Campaign, "links": [Link, ...] }`.
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

## Profile

Account-level integration settings for the Google Analytics 4 and Core Web
Vitals lookups used by [web analytics](#get-campaignscampaignidweb-analytics).
This stack is effectively single-tenant, so there is one shared profile
rather than one per user. Secrets (the GA4 service account and the CrUX API
key) are stored in SSM SecureStrings and are **never returned** — responses
only report whether each integration is configured.

### GET /profile

Read the current integration settings.

**Authentication:** Cognito.

**Responses:**

- `200 OK` - [Profile](#profile-object).
- `500 Internal Server Error`.

Example success body:

```json
{
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

Store integration credentials. The GA4 service account and CrUX API key are
written to SSM SecureStrings; the GA4 property id is stored in DynamoDB. All
fields are optional — only those present are applied. The response is the
same shape as `GET /profile` and never echoes the secrets back.

**Authentication:** Cognito.

**Request body** (all fields optional):

| Field | Type | Notes |
| --- | --- | --- |
| `ga4_property_id` | string | Numeric GA4 property id (e.g. `123456789`) |
| `ga4_service_account` | string | The Google service-account JSON key, as a string (contents of the downloaded key file). The service account needs Viewer on the GA4 property |
| `crux_api_key` | string | A Google API key with the CrUX API and PageSpeed Insights API enabled. <=200 chars |

Example request:

```json
{
  "ga4_property_id": "123456789",
  "ga4_service_account": "{ \"type\": \"service_account\", \"client_email\": \"...\", \"private_key\": \"-----BEGIN PRIVATE KEY-----\\n...\" }",
  "crux_api_key": "AIza..."
}
```

**Responses:**

- `200 OK` - updated [Profile](#profile-object).
- `400 Bad Request` - validation failure (non-numeric property id, malformed service account JSON).
- `500 Internal Server Error`.

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
| `ga4.property_id` | string \| null | Numeric GA4 property id |
| `ga4.service_account_email` | string \| null | `client_email` from the stored service account |
| `ga4.configured` | boolean | True when both a property id and service account are stored |
| `core_web_vitals.configured` | boolean | True when a CrUX/PageSpeed API key is stored |
| `updated_at` | string (date-time) \| null | Last settings write |

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
