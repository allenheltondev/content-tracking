// Shared display formatters. Every route/component imports from here
// instead of defining its own copy — keep new formatters in this file.

// Currency with no cents (dashboard money is whole-dollar scale). Falls
// back to a plain "amount CODE" string when the currency code is invalid.
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

// Campaign date ranges are stored as plain YYYY-MM-DD strings, so they
// render verbatim. The separator is overridable for print contexts where
// the arrow glyph reads poorly (CampaignReport passes 'to').
export function formatDateRange(
  startDate: string | null,
  endDate: string | null,
  separator = '→',
): string {
  if (!startDate && !endDate) return '-';
  if (startDate && endDate) return `${startDate} ${separator} ${endDate}`;
  return startDate ?? endDate ?? '-';
}

// Locale date (no time). Empty for null, the raw string for unparseable
// input so bad data stays visible instead of vanishing.
export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

// Locale date + time. Same null/invalid contract as formatDate.
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export const intFmt = new Intl.NumberFormat('en-US');

export function fmtInt(n: number | null | undefined): string {
  return typeof n === 'number' && isFinite(n) ? intFmt.format(n) : '—';
}

// 1234 -> 1.2K, 2500000 -> 2.5M; small numbers get thousands separators.
export function fmtCompact(n: number | null | undefined): string {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(Math.round((n / 1e6) * 10) / 10).toString()}M`;
  if (abs >= 1e3) return `${(Math.round((n / 1e3) * 10) / 10).toString()}K`;
  return intFmt.format(n);
}

// 0.123 -> "12.3%"
export function fmtPercent(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function titleCase(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// "5m ago" / "3h ago" / "2d ago" for freshness stamps.
export function relativeTime(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
