# MCP server

Booked exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server so agents such as Muse can manage campaigns. It implements spec
revision **2026-07-28** over Streamable HTTP. Clients still on 2025-era
revisions (those that open with `initialize`) are served through the SDK's
stateless fallback.

- **Endpoint:** `POST {ContentTrackingApiBaseUrl}/mcp` (stack output
  `McpServerUrl`)
- **Auth:** `Authorization: Bearer <API key>`
- **Code:** `functions/mcp/` (handler and tool definitions),
  `api/services/campaign-actions.mjs` (the mutations, shared with the REST
  routes)

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

| Tool | What it does | Annotations |
| --- | --- | --- |
| `list_campaigns` | Campaigns, newest first. Optional `status`, `limit` (max 100), `cursor`. | read-only |
| `list_vendors` | Vendors, newest first, for picking a `vendor_id`. | read-only |
| `create_campaign` | Creates a campaign. Same fields and rules as `POST /campaigns`, plus an optional `payout` (`amount`, `currency`, `invoice_ref`) and `idempotency_key`. | not idempotent unless a key is sent |
| `update_campaign_status` | Sets `draft`, `active`, `monitoring`, or `completed`. | idempotent |
| `mark_campaign_paid` | Sets `paid: true`. `paid_at` defaults to today (UTC). Optional `invoice_ref`. A campaign with no payout amount needs `amount` in the same call. | idempotent |

Each successful call returns `structuredContent` plus the same JSON as a text
block. Validation failures and missing campaigns come back as tool results
with `isError: true` and the API's error message, so the model can correct
the call. Unexpected failures are logged and reported as a generic error.

`create_campaign` with an `idempotency_key` stores the result for 24 hours
under the tenant and key. A retry with the same key and arguments returns the
original campaign. Reusing a key with different arguments is an error.

Status changes are not restricted to a workflow order, matching
`PATCH /campaigns/{campaignId}`.

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
  is added; API Gateway REST caps integrations at 29 seconds and buffers
  responses.
