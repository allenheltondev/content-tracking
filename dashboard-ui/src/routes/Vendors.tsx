import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch } from '../auth/useApiFetch';
import { listVendors } from '../api/vendors';
import type { Vendor } from '../api/types';

export default function Vendors(): ReactElement {
  const apiFetch = useApiFetch();
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    listVendors(apiFetch, { limit: 200 })
      .then((res) => {
        if (!cancelled) setVendors(res.vendors);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  const filtered = useMemo(() => {
    if (!vendors) return null;
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return vendors;
    return vendors.filter((v) => {
      if (v.name.toLowerCase().includes(needle)) return true;
      if (v.tags.some((t) => t.toLowerCase().includes(needle))) return true;
      if (v.contact_email?.toLowerCase().includes(needle)) return true;
      return false;
    });
  }, [vendors, search]);

  return (
    <section className="vendors-list">
      <header className="page-header">
        <h1>Vendors</h1>
        <Link to="/vendors/new" className="primary as-button">
          Add vendor
        </Link>
      </header>

      <div className="filter-bar">
        <input
          type="search"
          placeholder="Search name, tag, or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && <p className="form-error">{error}</p>}
      {filtered === null && !error && <p>Loading...</p>}
      {filtered && filtered.length === 0 && vendors && vendors.length === 0 && (
        <div className="empty-state">
          <p>No vendors yet.</p>
          <Link to="/vendors/new" className="primary as-button">
            Add your first vendor
          </Link>
        </div>
      )}
      {filtered && filtered.length === 0 && vendors && vendors.length > 0 && (
        <p className="empty-state-inline">No vendors match "{search}".</p>
      )}
      {filtered && filtered.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              <th>Tags</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((v) => (
              <tr key={v.vendor_id}>
                <td>
                  <Link to={`/vendors/${v.vendor_id}`}>{v.name}</Link>
                </td>
                <td>{v.contact_email ?? '-'}</td>
                <td>
                  {v.tags.length === 0
                    ? '-'
                    : v.tags.map((t) => (
                        <span className="tag-chip tag-chip-static" key={t}>
                          {t}
                        </span>
                      ))}
                </td>
                <td>{v.created_at.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
