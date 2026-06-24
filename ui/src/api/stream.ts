import { env } from '../auth/config';
import type { BlogAnswerSource } from './types';

// Client for the streaming Function URL. The endpoint emits newline-delimited
// JSON events; we surface deltas via a callback and return the terminal payload
// (sources, for ask). Throws on transport/model errors so callers can fall back
// to the buffered REST endpoint.

export function streamingEnabled(): boolean {
  return typeof env.streamBaseUrl === 'string' && env.streamBaseUrl.length > 0;
}

interface StreamResult {
  sources?: BlogAnswerSource[];
}

export async function streamGenerate(
  token: string,
  body: Record<string, unknown>,
  onDelta: (text: string) => void,
): Promise<StreamResult> {
  if (!env.streamBaseUrl) throw new Error('Streaming is not configured');

  const res = await fetch(env.streamBaseUrl, {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Stream request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: StreamResult = {};

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process complete lines; keep any trailing partial line in the buffer.
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;

      const event = JSON.parse(line) as
        | { type: 'delta'; text: string }
        | { type: 'done'; sources?: BlogAnswerSource[] }
        | { type: 'error'; message: string };

      if (event.type === 'delta') onDelta(event.text);
      else if (event.type === 'error') throw new Error(event.message);
      else if (event.type === 'done') result = { sources: event.sources };
    }
  }

  return result;
}
