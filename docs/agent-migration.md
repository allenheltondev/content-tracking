# Migrating Booked's chat onto the shared RSC agent runtime

Plan for replacing Booked's self-hosted Bedrock RAG chat with the shared
`@readysetcloud/agent` runtime (rsc-core), grounded through a Booked-hosted
`search_blog` MCP server. Realizes rsc-core issues #196/#197.

> **Status: blocked on precondition.** Do not start editing Booked's live chat
> code until rsc-core PR #212 (autonomous tasks + shared runtime) is **deployed
> to a non-prod stack and verified** — specifically the chat wss round-trip, the
> `InvokeAgentRuntime` auth path, and `authHeader` propagation. Phase 1 (the MCP
> server) is additive and can be built/tested standalone ahead of that.

## Where Booked is today (baseline)

Fully self-hosted on AWS Bedrock; **no** rsc-core agent integration.

- **Chat/RAG:** Titan embeddings → S3 Vectors (the user's own blog chunks) →
  Nova Pro Converse, streamed over a Lambda Function URL.
  - `functions/stream-generate/index.mjs` — streaming NDJSON Function URL (`ask`
    + `compose`).
  - `api/services/bedrock-stream.mjs` — `streamBlogAnswer` / `streamVoicePost`.
  - `api/services/bedrock.mjs` — buffered `answerBlogQuestion` + the
    `record_blog_answer` Converse tool; `POST /blogs/ask` (`api/routes/blogs.mjs`).
  - Retrieval primitive: **`api/services/content-vectors.mjs::queryContentChunks`**.
- **No server-side conversation memory** — each turn is independent; UI history is
  visual only (`ui/src/components/ChatWidget.tsx`, `sessionStorage`).
- **Tenant = Cognito `sub`** — retrieval passes `tenantId: sub` directly; there is
  **no** sub→tenant mapping table (sub *is* the partition key).
- **Auth:** shared RSC Cognito user pool (`@readysetcloud/ui/auth`,
  `api/authorizer.mjs`).
- **Vector store infra:** `BlogVectorBucket` + `ContentVectorIndex` (+
  `BlogVoiceIndex`), fed by `functions/vectorize-content/` — **kept** (it becomes
  the MCP tool's backing store).

## Target architecture

Booked's chat UI talks to the **shared runtime** (rsc-core). The runtime runs the
LLM loop and calls back into a **Booked-hosted `search_blog` MCP server** for
grounding, carrying the verified user identity via an `authHeader` Booked mints.

```
Booked UI ──(wss, Cognito bearer)──▶ rsc-core AgentCore runtime
                                          │  (loads session config: mcpServers.search_blog)
                                          ▼
                              Booked search_blog MCP server ──▶ queryContentChunks (S3 Vectors)
                                 (verifies authHeader → sub → tenantId)
```

## Phases

### Phase 1 — `search_blog` MCP server (net-new, additive) — ✅ DONE
Built in `functions/blog-mcp/` on branch `feat/blog-search-mcp`:
- **`index.mjs`** — Lambda Function URL (`AuthType: NONE`) hosting the MCP SDK's
  Web-Standard Streamable-HTTP transport (stateless, JSON responses; Fetch
  `Request`/`Response` — no Node req/res shim). Wire-compatible with the runtime's
  MCP client (same `@modelcontextprotocol/sdk`).
- **`server.mjs`** — one `search_blog` tool = `embedText` (Titan) →
  `queryContentChunks({ tenantId, … })`, returning citable passages as text. A
  fresh server is built per request with the verified tenant in closure, so
  retrieval can't cross tenants.
- **`auth.mjs`** — verifies the authority-minted `authHeader`
  (`base64url(payload).base64url(HMAC_SHA256(secret, payloadB64))`), extracts the
  verified `sub`, uses it directly as `tenantId` (sub == tenant — the #197
  "sub→tenant mapping" is a no-op). Version-gated for revocation. Rejects
  unsigned/invalid calls (401). Fails closed if the secret is unset.
- **Infra:** `BlogMcpFunction` + Function URL + `BlogMcpUrl` output; `bedrock:
  InvokeModel` + `s3vectors:Query/GetVectors` IAM; new `AgentMcpAuthSecret` param
  (optional, fails closed empty). Vector/embedding env inherited from Globals.
- **Tests:** `auth.test.mjs` + `index.test.mjs` (full initialize/tools-call flow,
  mocked Bedrock/S3Vectors, asserts tenant-scoped retrieval) — 9 passing.
- Deletes nothing; the current chat path is untouched.

**Before this is usable:** set a strong `AgentMcpAuthSecret` at deploy, and (Phase
2 / rsc-core) add the `BlogMcpUrl` host to `MCP_ALLOWED_HOSTS`. A live end-to-end
check against the shared runtime's MCP client is the remaining verification.

#### Hosting decision: direct MCP server, not AgentCore Gateway (for now)

We evaluated hosting `search_blog` through **AgentCore Gateway** and chose the
direct MCP server instead, because Gateway can't deliver the *verified* user
identity to the tool without extra infrastructure our single read-only tool
doesn't justify yet:

- **Lambda target** — the Gateway invokes it with the gateway's own IAM role;
  `event` is only the tool args and `context` only Gateway/tool IDs. The
  authenticated `sub` never reaches it. The only fix is a REQUEST **interceptor
  Lambda** that injects the `sub` into the args — custom, and a second Lambda.
- **MCP-server / OpenAPI target** — Gateway *can* carry identity here, but only
  via **OBO token exchange**, which requires a real OAuth2 IdP with RFC-8693
  token exchange (the runtime would forward a real OAuth token, not our HMAC
  `authHeader`). That's the standard/managed path, but it's meaningful infra.
- **Sessions** bind a session to the verified user (anti-hijack) but don't hand
  the identity to a Lambda target either — they add security/statefulness, not
  last-hop delivery.

Because our server **is** the MCP endpoint, it terminates the MCP session and
reads the forwarded identity token directly (`auth.mjs`) — sidestepping
interceptor/OBO/IdP entirely. That's the right trade for one per-tenant tool
called by an already-MCP-native runtime.

**Upgrade path (no rewrite):** this Function URL server is itself a valid Gateway
**MCP-server target**. When Booked exposes multiple tools or wants the managed
front door, put a Gateway in front (sessions + OBO) and register *this same
server* as an MCP-server target — the tool logic (`server.mjs`) is unchanged; you
add the OAuth IdP/OBO when you're ready to run it.

### Phase 2 — grounded session creation (Booked backend)
- Booked's backend (the **authority**) creates the rsc-core session with
  `mcpServers.search_blog = { url, authHeader: mint(sub, sessionId) }`, minting the
  HMAC server-side with a secret it *also* holds in the MCP server (Booked is both
  authority and verifier). rsc-core forwards the header verbatim (#197) and the
  browser never sees the secret.
- Config: `CORE_API_URL`, the MCP Function URL, the shared `authHeader` secret.

### Phase 3 — UI rewire (feature-flagged)
- Swap `ChatWidget` transport from the NDJSON Function URL to the shared runtime —
  either adopt `@readysetcloud/ui/chat` (already speaks the wss protocol) or rewire
  the custom widget to `/agent/connect`. Behind a `VITE_USE_SHARED_AGENT` flag;
  keep the old path live.

### Phase 4 — cutover & cleanup
- Enable the flag in prod; verify grounded answers, streaming, and cross-session
  memory.
- **Delete:** `functions/stream-generate/`, `api/services/bedrock-stream.mjs`, the
  chat half of `bedrock.mjs` (`answerBlogQuestion` / `record_blog_answer`),
  `POST /blogs/ask`, `ui/src/api/stream.ts`, `ui/src/api/blogs.ts` (askBlog),
  `StreamGenerateFunction` + its Function URL/outputs.
- **Keep:** the vector store + ingestion (`vectorize-content`, `embeddings`,
  `chunking`) — now serving the MCP tool — and the whole voice pipeline.

### rsc-core side (small)
- Add Booked's MCP host to `MCP_ALLOWED_HOSTS` (#196) once the Function URL is
  stable.

## Open questions (resolve at execution, against the deployed runtime)
- **How Booked's backend authenticates to rsc-core to create the session** — a
  service Cognito token vs the cross-account `requestSession` event path.
- **Memory is an upgrade:** the shared runtime adds AgentCore cross-session memory;
  Booked's chat has none today. Confirm this is desired product behavior.
- Keep Booked's custom widget shell, or adopt `@readysetcloud/ui/chat` wholesale.
- Confirm the runtime's chat auth (Cognito bearer over wss) is unaffected by the
  autonomous-task work landing in the same runtime.
