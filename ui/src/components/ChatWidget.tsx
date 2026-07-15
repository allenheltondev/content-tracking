import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Chat } from '@readysetcloud/ui/chat';
import { useAuth } from '../auth/useAuth';
import { agentChatEnabled, createBlogSession, makeGetConnectionUrl } from '../api/agent';

// App-wide "Ask your blog" assistant. Mounted once in the App shell so it's
// reachable from every page. The conversation is owned by the shared
// @readysetcloud/agent runtime (AgentCore): the widget creates a session, opens
// a presigned wss:// connection to the runtime, and streams over the shared
// chat protocol. History lives in the runtime's snapshots, keyed by sessionId —
// we persist just that id to sessionStorage so a reload resumes the same thread.
//
// Blog grounding (a `search_blog` tool the session references via mcpServers)
// is not wired yet; until the MCP bridge lands the assistant answers without
// retrieving from published posts. See the C1/C2/R1/R2 gap issues.

const SESSION_KEY = 'booked-agent-session-id';

function loadSessionId(): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function storeSessionId(id: string | null): void {
  try {
    if (id) window.sessionStorage.setItem(SESSION_KEY, id);
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore — a missing/full store just means the thread won't survive reload */
  }
}

export default function ChatWidget(): ReactElement | null {
  const { user, getAccessToken } = useAuth();

  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(() => loadSessionId());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A stable presigner for the chat client to call on every (re)connect.
  const getConnectionUrl = useMemo(() => makeGetConnectionUrl(getAccessToken), [getAccessToken]);

  // Guards against creating two sessions without being an effect dependency —
  // a ref, not `creating` state, because a state dep that the effect also sets
  // would re-run the effect, and its cleanup would cancel the in-flight create
  // (discarding the sessionId and wedging the widget on "Starting…").
  const creatingRef = useRef(false);

  // Create a session lazily the first time the widget opens, so users who never
  // open it don't hit the Core API. A stored id (from an earlier open or a
  // reload) is reused, resuming that conversation from the runtime's snapshots.
  useEffect(() => {
    if (!open || sessionId || creatingRef.current) return;
    creatingRef.current = true;
    let cancelled = false;
    setCreating(true);
    setError(null);
    createBlogSession(getAccessToken)
      .then((id) => {
        if (cancelled) return;
        storeSessionId(id);
        setSessionId(id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        creatingRef.current = false;
        if (!cancelled) setCreating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, getAccessToken]);

  const startNewChat = (): void => {
    creatingRef.current = false;
    storeSessionId(null);
    setSessionId(null);
    setError(null);
  };

  // Hidden entirely when the shared Core API isn't configured for this build.
  // Warn so a missing VITE_CORE_API_URL is diagnosable rather than a silent
  // no-icon (it renders nothing, so there's otherwise no signal).
  if (!agentChatEnabled()) {
    console.warn('[ChatWidget] hidden: VITE_CORE_API_URL is not set, so "Ask your blog" cannot presign its connection.');
    return null;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open blog assistant"
        className="btn btn-primary fixed bottom-4 right-4 z-40 h-12 w-12 rounded-full p-0 text-xl shadow-lg"
      >
        <span aria-hidden>💬</span>
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Ask your blog"
      className="fixed bottom-4 right-4 z-40 flex w-[min(22rem,calc(100vw-2rem))] max-h-[min(70vh,34rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
    >
      <div className="flex items-center justify-end gap-1 border-b border-border px-2 py-1.5">
        <button
          type="button"
          className="btn-link text-xs"
          onClick={startNewChat}
          disabled={creating || !sessionId}
        >
          New chat
        </button>
        <button
          type="button"
          aria-label="Close blog assistant"
          className="btn btn-ghost btn-sm px-2"
          onClick={() => setOpen(false)}
        >
          <span aria-hidden>✕</span>
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="space-y-2 p-4 text-sm">
            <p className="form-error">Could not start the assistant: {error}</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={startNewChat}>
              Try again
            </button>
          </div>
        ) : sessionId ? (
          <Chat
            sessionId={sessionId}
            userId={user?.username}
            getConnectionUrl={getConnectionUrl}
            title="Ask your blog"
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">Starting your assistant…</p>
        )}
      </div>
    </div>
  );
}
