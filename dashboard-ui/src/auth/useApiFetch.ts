import { useCallback } from 'react';
import { useAuth } from 'react-oidc-context';
import { env } from './config';

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

// Hook that returns an authenticated fetch wrapper. Pulls the access
// token from the current session and injects it as the Authorization
// header per docs/deploy-guide.md (raw access token, not "Bearer X").
// Returns the parsed JSON body on success, throws ApiError on failure.
export function useApiFetch(): ApiFetch {
  const auth = useAuth();

  return useCallback(
    async <T,>(path: string, options: RequestOptions = {}): Promise<T> => {
      const token = auth.user?.access_token;
      if (!token) {
        throw new ApiError(401, 'No access token available; sign in first.', null);
      }

      const url = new URL(`${env.apiBaseUrl}${path}`);
      if (options.query) {
        for (const [k, v] of Object.entries(options.query)) {
          if (v !== undefined && v !== null && v !== '') {
            url.searchParams.set(k, String(v));
          }
        }
      }

      const headers: Record<string, string> = {
        Authorization: token,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      };

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: options.method ?? 'GET',
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
    [auth],
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
