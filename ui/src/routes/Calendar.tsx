import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '../auth/useApiFetch';
import { listContent } from '../api/content';
import type { ContentStatus, ContentSummary } from '../api/types';

// Content calendar: every piece placed on its publish date (falling back to the
// creation date), colored by status. The date a piece is anchored to is the
// heart of a creator's schedule, so this is the app's planning surface.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const STATUS_DOT: Record<ContentStatus, string> = {
  draft: 'bg-muted-foreground',
  scheduled: 'bg-warning-500',
  published: 'bg-success-500',
  archived: 'bg-secondary-400',
};

// The day a piece sits on: its publish date, else the calendar day it was
// created. Both normalize to a YYYY-MM-DD key.
function dayKey(c: ContentSummary): string {
  return c.publish_date ?? c.created_at.slice(0, 10);
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1)).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function Calendar(): ReactElement {
  const apiFetch = useApiFetch();

  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth()); // 0-11

  const { data, error: queryError } = useQuery({
    queryKey: ['calendar'],
    queryFn: () => listContent(apiFetch, {}),
  });
  const content: ContentSummary[] = useMemo(() => data?.content ?? [], [data]);
  const error = queryError ? (queryError as Error).message : null;

  const byDay = useMemo(() => {
    const map = new Map<string, ContentSummary[]>();
    for (const c of content) {
      const key = dayKey(c);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return map;
  }, [content]);

  // Build the grid: leading blanks to align the 1st on its weekday, then each
  // day of the month. Everything in UTC so a date key matches its cell.
  const cells = useMemo(() => {
    const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const out: (string | null)[] = [];
    for (let i = 0; i < firstWeekday; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      out.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    return out;
  }, [year, month]);

  const step = (delta: number): void => {
    const d = new Date(Date.UTC(year, month + delta, 1));
    setYear(d.getUTCFullYear());
    setMonth(d.getUTCMonth());
  };

  const goToday = (): void => {
    const t = new Date();
    setYear(t.getUTCFullYear());
    setMonth(t.getUTCMonth());
  };

  const todayKey = new Date().toISOString().slice(0, 10);

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Calendar</h1>
          <p className="text-sm text-muted-foreground">Your content by publish date, colored by status.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => step(-1)}>← Prev</button>
          <span className="min-w-40 text-center font-medium text-foreground">{monthLabel(year, month)}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => step(1)}>Next →</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={goToday}>Today</button>
        </div>
      </header>

      {error && <p className="form-error">Could not load content: {error}</p>}

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {(Object.keys(STATUS_DOT) as ContentStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5 capitalize">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${STATUS_DOT[s]}`} />{s}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-px rounded-lg overflow-hidden border border-border bg-border">
        {WEEKDAYS.map((w) => (
          <div key={w} className="bg-muted px-2 py-1.5 text-xs font-medium text-muted-foreground text-center">{w}</div>
        ))}
        {cells.map((key, i) => (
          <div key={key ?? `blank-${i}`} className={`min-h-24 bg-background p-1.5 ${key === todayKey ? 'ring-1 ring-inset ring-primary-400' : ''}`}>
            {key && (
              <>
                <div className={`text-xs mb-1 ${key === todayKey ? 'font-semibold text-primary-600' : 'text-muted-foreground'}`}>
                  {Number(key.slice(8))}
                </div>
                <ul className="space-y-1">
                  {(byDay.get(key) ?? []).map((c) => (
                    <li key={c.content_id}>
                      <Link
                        to={`/content/${c.content_id}`}
                        className="flex items-center gap-1 text-xs text-foreground hover:text-primary-600 truncate"
                        title={c.title}
                      >
                        <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${c.status ? STATUS_DOT[c.status] : 'bg-muted-foreground'}`} />
                        <span className="truncate">{c.title}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
