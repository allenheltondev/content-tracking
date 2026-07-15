import { env } from '../auth/config';

// Client for the "Ask your blog" agent. Two backends are involved:
//   - Booked's own API creates the session (POST /agent/sessions). Booked mints
//     the session server-side because it must carry a Booked-signed grant the
//     browser can't hold, and because Booked owns the assistant's behavior
//     (system prompt) and blog-search wiring. The browser sends nothing but its
//     identity.
//   - The shared rsc-core Core API presigns the wss:// connection to the
//     AgentCore runtime (POST /agent/connect). The chat client opens that socket
//     directly to the runtime.
// Identity for both is the shared Cognito id token; both APIs sign into the same
// pool, so the token the dashboard already holds authenticates these calls and
// becomes the agent's verified userId server-side.

/** True when the shared Core API is configured (needed to presign the socket). */
export function agentChatEnabled(): boolean {
  return typeof env.coreApiUrl === 'string' && env.coreApiUrl.length > 0;
}

async function post<T>(
  baseUrl: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
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
 * Creates an "Ask your blog" agent session via Booked's API and returns its id.
 * Booked verifies the caller, mints the blog-search grant, and proxies session
 * creation to the Core API — so the assistant's prompt and blog grounding are
 * server-authoritative, not client-supplied.
 */
export async function createBlogSession(
  getToken: () => Promise<string>,
): Promise<string> {
  const token = await getToken();
  const { sessionId } = await post<{ sessionId: string }>(
    env.apiBaseUrl,
    '/agent/sessions',
    token,
    {},
  );
  return sessionId;
}

/**
 * Builds the `getConnectionUrl` the chat client calls on every (re)connect. It
 * presigns a short-lived wss:// URL to the AgentCore runtime (via the Core API),
 * carrying the verified sub as a custom header server-side. Never pass a
 * client-supplied user id — the presigner derives it from the token.
 */
export function makeGetConnectionUrl(
  getToken: () => Promise<string>,
): (sessionId?: string) => Promise<string> {
  return async (sessionId?: string) => {
    if (!env.coreApiUrl) throw new Error('Core API is not configured');
    const token = await getToken();
    const { wsUrl } = await post<{ wsUrl: string }>(env.coreApiUrl, '/agent/connect', token, {
      ...(sessionId ? { sessionId } : {}),
    });
    return wsUrl;
  };
}
