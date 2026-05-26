import type { Pair } from './KeyValueEditor';

export function pairsToObject(pairs: Pair[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const key = p.key.trim();
    if (key.length === 0) continue;
    out[key] = coerce(p.value);
  }
  return out;
}

export function objectToPairs(obj: Record<string, unknown> | undefined): Pair[] {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}

// Numbers and booleans inside targetMetrics survive a round-trip through
// the form. Everything else stays a string.
function coerce(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return raw;
}
