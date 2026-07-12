import { useCallback } from 'react';
import { env } from './config';
import { useAuth } from './useAuth';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
}

export type ApiFetch = <T = unknown>(path: string, options?: RequestOptions) => Promise<T>;

// Hook returning an authenticated fetch wrapper. Pulls a fresh id token
// from the shared auth core on every call so token refreshes happen
// transparently. The token is sent as the raw `Authorization` header
// (not `Bearer X`) per the API's Cognito authorizer config.
export function useApiFetch(): ApiFetch {
  const { getAccessToken } = useAuth();

  return useCallback(
    async <T,>(path: string, options: RequestOptions = {}): Promise<T> => {
      let token: string;
      try {
        token = await getAccessToken();
      } catch (err) {
        throw new ApiError(401, (err as Error).message, null);
      }

      const url = new URL(`${env.apiBaseUrl}${path}`);
      if (options.query) {
        for (const [k, v] of Object.entries(options.query)) {
          if (v !== undefined && v !== null && v !== '') {
            url.searchParams.set(k, String(v));
          }
        }
      }

      const method = options.method ?? 'GET';
      const headers: Record<string, string> = {
        Authorization: token,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        // POST is the only non-idempotent method exposed by the API.
        // Attach a per-call key so safe client-side retries dedupe
        // server-side instead of creating duplicate resources. Callers
        // can override by passing their own Idempotency-Key in headers.
        ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
        ...(options.headers ?? {}),
      };

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
      } catch (err) {
        throw new ApiError(0, `Network error: ${(err as Error).message}`, null);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const isJson = contentType.includes('application/json');
      const bodyText = await response.text();
      const parsed = isJson && bodyText.length > 0 ? safeJson(bodyText) : bodyText;

      if (!response.ok) {
        const message = extractMessage(parsed) ?? `${response.status} ${response.statusText}`;
        throw new ApiError(response.status, message, parsed);
      }

      return parsed as T;
    },
    [getAccessToken],
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractMessage(body: unknown): string | null {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    return typeof m === 'string' ? m : null;
  }
  return null;
}
