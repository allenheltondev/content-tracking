# MCP server

Booked exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server so agents such as Muse can manage campaigns. It implements spec
revision **2026-07-28** over Streamable HTTP. Clients still on 2025-era
revisions (those that open with `initialize`) are served through the SDK's
stateless fallback.

- **Endpoint:** `POST {ContentTrackingApiBaseUrl}/mcp` (stack output
  `McpServerUrl`)
- **Auth:** `Authorization: Bearer <API key>`
- **Code:** `functions/mcp/index.mjs` (handler), `functions/mcp/server.mjs`
  (assembly), `functions/mcp/tools/*.mjs` (one module per area). Business
  logic lives in `api/services` and `api/domain`, shared with the REST
  routes: `campaign-actions.mjs`, `campaign-reports.mjs`,
  `campaign-web-analytics.mjs`, `brief-pipeline.mjs`.

## Connecting Muse

1. In the dashboard, open **Settings > API keys** and mint a key labelled
   for the agent (for example `muse`). Copy it. It is shown once.
2. Add a remote MCP server in Muse with the `McpServerUrl` value and a
   static header `Authorization: Bearer <key>`.
3. Revoke the key from the same settings tab to cut the agent off. The
   authorizer is uncached, so revocation applies to the next call.

A quick check from a shell:

```bash
curl -sS -X POST "$BOOKED_MCP_URL" \
  -H "Authorization: Bearer $BOOKED_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/list" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}}}}'
```

## Tools

Every tool is scoped to the key's tenant and checks that the campaign or
vendor it names belongs to that tenant. A foreign or missing id comes back
as "not found".

### Campaigns

| Tool | What it does |
| --- | --- |
| `list_campaigns` | Campaigns, newest first. Optional `status`, `limit` (max 100), `cursor`. |
| `get_campaign` | One campaign with its links, social posts, content posts (current metrics), brief summary, and draft. |
| `create_campaign` | Same fields and rules as `POST /campaigns`, plus an optional `payout` (`amount`, `currency`, `invoice_ref`). |
| `update_campaign` | Edit name, sponsor, vendor, dates, deliverable, URLs, target metrics. Status and payout have their own tools. |
| `update_campaign_status` | Move along the lifecycle below. |
| `update_campaign_payout` | Change amount, currency, invoice reference, or paid state. `paid: false` clears `paid_at`. |
| `mark_campaign_paid` | Record a payment. `paid_at` defaults to today (UTC). A campaign with no amount needs `amount` in the same call. |

### Vendors

| Tool | What it does |
| --- | --- |
| `list_vendors` | Vendors, newest first. |
| `get_vendor` | One vendor and its campaigns. |
| `create_vendor` | Add a sponsor. Optional readable `vendor_id`. |
| `update_vendor` | Edit contact details, payment terms, tags, notes. |

### Deliverables

| Tool | What it does |
| --- | --- |
| `add_campaign_link` | Mint a tracked short link (`role`: main, cross_post, social_promo). |
| `update_campaign_link` | Edit notes, src tag, or expiry. |
| `delete_campaign_link` | Delete the link and retire its short URL. |
| `add_social_post` / `add_content_post` | Track a post. Platform is derived from the URL when omitted. |
| `record_social_post_metrics` / `record_content_post_metrics` | Replace the post's metrics and write today's history point. |
| `delete_social_post` / `delete_content_post` | Stop tracking a post. |

### Brief and draft

| Tool | What it does |
| --- | --- |
| `attach_campaign_brief` | Attach a brief as `text` or as the sponsor `conversation`. Returns a summary and suggested fields to apply with `update_campaign`. |
| `save_campaign_draft` | Save the Google Doc link for the working draft. |
| `review_campaign_draft` | Review the draft against the brief and store the feedback. |

### Reporting

| Tool | What it does |
| --- | --- |
| `get_campaign_analytics` | Link click totals, overall and per link. |
| `get_campaign_web_analytics` | GA4 and Core Web Vitals for a blog, or YouTube stats. Optional GA4 date range (default 28 days). |
| `generate_campaign_report` | Build a sponsor-facing report. Returns a signed URL, a short URL, and a stable link to the newest report. |
| `list_campaign_reports` | Retained reports with fresh signed links. |

### Status lifecycle

The MCP tools enforce the campaign lifecycle:

| From | Allowed moves |
| --- | --- |
| `draft` | `active` |
| `active` | `draft`, `monitoring`, `completed` |
| `monitoring` | `active`, `completed` |
| `completed` | none |

Moving to the current status is a no-op. A refused move returns an error
naming the allowed moves. The rules live in `CAMPAIGN_STATUS_TRANSITIONS`
(`api/validation/campaign.mjs`). The dashboard's status picker is a manual
override and is not restricted, so reopening a completed campaign is a
dashboard action. `create_campaign` may start a campaign in any status, so
past deals can be recorded as completed.

### Results, errors, retries

Each successful call returns `structuredContent` plus the same JSON as a text
block. Validation failures, refused moves, and missing records come back as
tool results with `isError: true` and the API's message, so the model can
correct the call. Unexpected failures are logged and reported as a generic
error.

Create and add tools take an optional `idempotency_key`. The result is
stored for 24 hours under the tool, tenant, and key, so a retry with the same
key and arguments returns the original record instead of a duplicate.
Reusing a key with different arguments is an error. Update, record, and
delete tools are safe to repeat as they are.

### Left to the dashboard

- PDF and DOCX brief uploads (they go through a presigned S3 upload).
- Deleting vendors (it unlinks every campaign).
- Engagement recommendations and daily metric history charts.
- Vendor reports, revenue, and the media kit.

## Auth and tenancy

`BookedAuthorizer` verifies the key before the function runs, exactly as for
the REST routes. The handler then calls `requireAgentTenantId`, which accepts
an API key or a dashboard token and rejects Chrome extension tokens with
`401`. The tenant comes only from the verified token and is bound into every
tool when the server is built. No tool takes a tenant argument.

API keys are minted in the dashboard rather than through an OAuth
authorization server, so the server does not publish OAuth protected resource
metadata. Clients must be configured with the key up front. Adding OAuth (for
example, for claude.ai custom connectors) means standing up client
registration in front of Cognito and serving
`/.well-known/oauth-protected-resource`.

Requests that carry an `Origin` header are rejected with `403` unless the
hostname is listed in `MCP_ALLOWED_ORIGIN_HOSTS` (comma separated, empty by
default). Agents call from servers and send no `Origin`.

## Why a plain Lambda

The 2026-07-28 revision is stateless: no `initialize` handshake, no session
id, and protocol version and capabilities ride on every request. Every tool
here answers with a single JSON body, so there is nothing to stream. That
makes the endpoint an ordinary request/response Lambda:

- The REST API already provides the custom domain, the authorizer, and
  revocation. An explicit `/mcp` resource takes precedence over
  `ApiFunction`'s `/{proxy+}`.
- `@modelcontextprotocol/server` (v2) handles the protocol through
  `createMcpHandler(...).fetch(Request)`. The handler converts the API
  Gateway event to a web `Request` and the `Response` back, which covers
  `server/discover`, header validation (`Mcp-Method`, `Mcp-Name`), version
  negotiation, and 405 for `GET`/`DELETE`.
- The Lambda Web Adapter and a response-streaming Function URL only pay off
  for long-running tools that stream progress. Revisit them if such a tool
  is added. API Gateway REST caps integrations at 29 seconds and buffers
  responses. The slowest tools (brief summaries, draft reviews, report
  generation) run inside that limit today, as they do on the REST routes.
- The function has its own role: table access, SSM reads for the
  newsletter-service and analytics keys, Bedrock, and the briefs and reports
  buckets. It cannot write SSM parameters or touch vectors.
