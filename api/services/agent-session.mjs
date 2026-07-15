import { UnauthorizedError, UpstreamError } from "./errors.mjs";
import { logger } from "./logger.mjs";

// Thin client for the shared rsc-core Core API's agent surface. Booked creates
// the agent session server-side (rather than letting the browser call rsc-core
// directly) because the session must carry a Booked-minted grant the browser
// can't hold. The session config itself lives in rsc-core's table, so the only
// way to create it is through this API — Booked forwards the caller's verified
// Cognito id token, which rsc-core's JWT authorizer validates and records as the
// session owner (the same sub Booked minted the grant for).
//
// CORE_API_URL is the rsc-core SSM /readysetcloud/api-url value, resolved at
// deploy time into the Lambda env (prod: https://api.readysetcloud.io/core).

const CORE_API_URL = process.env.CORE_API_URL;

/**
 * Creates an agent session via the Core API and returns { sessionId, title }.
 *
 * @param {object}  args
 * @param {string}  args.authorization  The caller's Authorization header, forwarded verbatim (e.g. "Bearer <idToken>").
 * @param {string} [args.systemPrompt]  Assistant behavior for this session.
 * @param {string} [args.title]         Human label for the conversation.
 * @param {object} [args.mcpServers]    External MCP tool sources (the blog-search grant rides here); omitted when grounding is not configured.
 */
export async function createRuntimeSession({ authorization, systemPrompt, title, mcpServers }) {
  if (!CORE_API_URL) {
    throw new Error("CORE_API_URL env var is not set.");
  }
  if (!authorization) {
    throw new UnauthorizedError("Missing caller authorization.");
  }

  const res = await fetch(`${CORE_API_URL}/agent/sessions`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
    }),
  });

  if (!res.ok) {
    // A Core API failure is an upstream/config problem from the caller's point
    // of view (e.g. an MCP host not yet on rsc-core's allowlist —
    // readysetcloud/rsc-core#196 — returns 400 there). Map to a 502 that
    // carries the upstream status, and log the body for ops.
    const detail = await safeBody(res);
    logger.warn("Core API session create failed", { upstreamStatus: res.status, detail });
    throw new UpstreamError("Failed to create agent session", res.status);
  }

  const body = await res.json();
  return { sessionId: body.sessionId, title: body.title ?? null };
}

async function safeBody(res) {
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}
