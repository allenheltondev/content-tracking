import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch } from '../auth/useApiFetch';
import { getRevenue } from '../api/revenue';
import { listVendors } from '../api/vendors';
import type { RevenueResponse, Vendor } from '../api/types';
import RevenueChart from '../components/RevenueChart';

const CURRENT_YEAR = new Date().getUTCFullYear();
const WIDE_START = '1900-01-01';
const WIDE_END = '2999-12-31';

export default function Revenue(): ReactElement {
  const apiFetch = useApiFetch();

  // Drives the dropdown. Falls back to [currentYear] when the all-time
  // query hasn't returned yet, so the page renders something while the
  // year list resolves.
  const [availableYears, setAvailableYears] = useState<number[]>([CURRENT_YEAR]);
  const [year, setYear] = useState<number>(CURRENT_YEAR);

  const [monthly, setMonthly] = useState<RevenueResponse | null>(null);
  const [byVendor, setByVendor] = useState<RevenueResponse | null>(null);
  const [vendorMap, setVendorMap] = useState<Map<string, Vendor>>(new Map());

  const [monthlyError, setMonthlyError] = useState<string | null>(null);
  const [vendorError, setVendorError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  // One-time: discover years that have any revenue at all so the year
  // dropdown is data-driven instead of a hardcoded range. Falls back
  // silently if the call fails — current year stays in the list.
  useEffect(() => {
    let cancelled = false;
    getRevenue(apiFetch, {
      startDate: WIDE_START,
      endDate: WIDE_END,
      grouping: 'year',
    })
      .then((res) => {
        if (cancelled) return;
        const yearsFromData = res.groups
          .map((g) => Number(g.key))
          .filter((n) => Number.isInteger(n) && n > 1900);
        const merged = new Set<number>(yearsFromData);
        merged.add(CURRENT_YEAR);
        const sorted = [...merged].sort((a, b) => b - a);
        setAvailableYears(sorted);
      })
      .catch(() => {
        // Keep the fallback list; nothing to surface.
      });

    // Vendor lookup for the breakdown table.
    listVendors(apiFetch, { limit: 500 })
      .then((res) => {
        if (cancelled) return;
        setVendorMap(new Map(res.vendors.map((v) => [v.vendor_id, v])));
      })
      .catch(() => {
        // Best effort — table falls back to showing vendor ids.
      });

    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  // Per-year: two calls (month + vendor groupings).
  useEffect(() => {
    let cancelled = false;
    setMonthlyError(null);
    setVendorError(null);
    setMonthly(null);
    setByVendor(null);

    getRevenue(apiFetch, { year, grouping: 'month' })
      .then((res) => {
        if (!cancelled) setMonthly(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setMonthlyError(err.message);
      });

    getRevenue(apiFetch, { year, grouping: 'vendor' })
      .then((res) => {
        if (!cancelled) setByVendor(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setVendorError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [apiFetch, year]);

  const vendorRows = useMemo(() => {
    if (!byVendor) return null;
    const yearTotal = byVendor.total.amount;
    return byVendor.groups
      .map((g) => ({
        vendorId: g.key === 'unassigned' ? null : g.key,
        name: g.key === 'unassigned' ? 'Unassigned' : (vendorMap.get(g.key)?.name ?? g.key),
        booked: g.bookedAmount,
        received: g.receivedAmount,
        campaignCount: g.campaignCount,
        pctOfYear: yearTotal > 0 ? (g.amount / yearTotal) * 100 : 0,
      }))
      .sort((a, b) => b.booked - a.booked);
  }, [byVendor, vendorMap]);

  return (
    <section className="revenue-page">
      <header className="page-header">
        <h1>Revenue</h1>
        <label className="year-selector">
          <span className="field-label">Year</span>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {availableYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </header>

      {monthlyError && (
        <p className="form-error">Could not load revenue: {monthlyError}</p>
      )}

      {monthly && (
        <>
          <div className="analytics-tiles">
            <div className="tile">
              <span className="tile-label">Booked ({year})</span>
              <span className="tile-value">
                {formatMoney(monthly.booked.amount, monthly.currency)}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Received ({year})</span>
              <span className="tile-value">
                {formatMoney(monthly.received.amount, monthly.currency)}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Campaigns</span>
              <span className="tile-value">{monthly.total.campaignCount}</span>
            </div>
            <div className="tile">
              <span className="tile-label">Avg / campaign</span>
              <span className="tile-value">
                {monthly.total.campaignCount > 0
                  ? formatMoney(
                      monthly.total.amount / monthly.total.campaignCount,
                      monthly.currency,
                    )
                  : '-'}
              </span>
            </div>
          </div>

          {monthly.skipped.length > 0 && (
            <aside className="form-warning skipped-banner">
              <div>
                {monthly.skipped.length} campaign
                {monthly.skipped.length === 1 ? '' : 's'} skipped (non-USD currency).
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setShowSkipped((s) => !s)}
                >
                  {showSkipped ? 'Hide' : 'See details'}
                </button>
              </div>
              {showSkipped && (
                <ul className="skipped-list">
                  {monthly.skipped.map((s) => (
                    <li key={s.campaign_id}>
                      <Link to={`/campaigns/${s.campaign_id}`}>{s.campaign_id}</Link>:{' '}
                      {s.amount} {s.currency}
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          )}

          <section className="analytics-section">
            <h2>Trend</h2>
            <RevenueChart
              year={year}
              monthGroups={monthly.groups}
              currency={monthly.currency}
            />
          </section>
        </>
      )}

      <section className="links-section">
        <h2>By vendor</h2>
        {vendorError && (
          <p className="form-error">Could not load vendor breakdown: {vendorError}</p>
        )}
        {!byVendor && !vendorError && <p>Loading...</p>}
        {vendorRows && vendorRows.length === 0 && (
          <p>No revenue recorded for {year}.</p>
        )}
        {vendorRows && vendorRows.length > 0 && byVendor && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Campaigns</th>
                <th>Booked</th>
                <th>Received</th>
                <th>% of year</th>
              </tr>
            </thead>
            <tbody>
              {vendorRows.map((row) => (
                <tr key={row.vendorId ?? 'unassigned'}>
                  <td>
                    {row.vendorId ? (
                      <Link to={`/vendors/${row.vendorId}`}>{row.name}</Link>
                    ) : (
                      <span>{row.name}</span>
                    )}
                  </td>
                  <td>{row.campaignCount}</td>
                  <td>{formatMoney(row.booked, byVendor.currency)}</td>
                  <td>{formatMoney(row.received, byVendor.currency)}</td>
                  <td>{row.pctOfYear.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}

function formatMoney(amount: number, currency: string): string {
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
