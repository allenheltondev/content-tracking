import { env } from '../auth/config';

// Client for the shared Ready, Set, Cloud agent, hosted in AgentCore Runtime and
// fronted by the rsc-core Core API. The "Ask your blog" widget creates a session
// here (choosing the assistant's behavior via a system prompt) and then presigns
// a wss:// URL the chat client opens directly to the runtime. Identity is the
// shared Cognito id token; both apps sign into the same pool, so the token the
// dashboard already holds authenticates these calls and becomes the agent's
// verified userId server-side.
//
// The runtime is a GENERIC host: what the agent does is data set at session
// create, not code. Blog grounding will arrive as a `search_blog` tool the
// session references via `mcpServers`; until that MCP bridge + the rsc-core host
// allowlist land, sessions omit `mcpServers` and the assistant answers without
// blog retrieval. See the C1/C2/R1/R2 gap issues.

/** The blog assistant's system prompt, chosen at session-create time. */
const BLOG_ASSISTANT_PROMPT = `You are a research assistant for a content creator, helping them explore and reason about THEIR OWN published blog posts.

- When a blog search tool (e.g. search_blog) is available, use it to ground your answers in the creator's actual posts, and cite the posts you drew on.
- Base grounded claims only on what the tool returns. If the tool finds nothing relevant, say so plainly rather than inventing an answer.
- If no blog search tool is available, answer conversationally from context and make clear you are not drawing on their posts.
- Be concise and helpful. Format responses in Markdown when appropriate.`;

/** True when the shared Core API is configured, so the chat widget can run. */
export function agentChatEnabled(): boolean {
  return typeof env.coreApiUrl === 'string' && env.coreApiUrl.length > 0;
}

async function post<T>(
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<T> {
  if (!env.coreApiUrl) throw new Error('Core API is not configured');

  const res = await fetch(`${env.coreApiUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * Creates an agent session and returns its id. The verified caller (shared
 * Cognito sub) becomes the session owner; the runtime refuses the session for
 * any other user. The system prompt fixes the assistant's behavior for this
 * session — no redeploy needed to change it.
 */
export async function createBlogSession(
  getToken: () => Promise<string>,
): Promise<string> {
  const token = await getToken();
  const { sessionId } = await post<{ sessionId: string }>('/agent/sessions', token, {
    systemPrompt: BLOG_ASSISTANT_PROMPT,
    title: 'Ask your blog',
  });
  return sessionId;
}

/**
 * Builds the `getConnectionUrl` the chat client calls on every (re)connect. It
 * presigns a short-lived wss:// URL to the AgentCore runtime, carrying the
 * verified sub as a custom header server-side. Never pass a client-supplied
 * user id — the presigner derives it from the token.
 */
export function makeGetConnectionUrl(
  getToken: () => Promise<string>,
): (sessionId?: string) => Promise<string> {
  return async (sessionId?: string) => {
    const token = await getToken();
    const { wsUrl } = await post<{ wsUrl: string }>('/agent/connect', token, {
      ...(sessionId ? { sessionId } : {}),
    });
    return wsUrl;
  };
}
