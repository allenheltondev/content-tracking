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
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold text-foreground">Vendors</h1>
        <Link to="/vendors/new" className="btn-primary">
          Add vendor
        </Link>
      </header>

      <div className="flex items-center gap-3">
        <input
          type="search"
          className="input max-w-sm"
          placeholder="Search name, tag, or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && <p className="form-error">{error}</p>}
      {filtered === null && !error && <p className="text-muted-foreground">Loading...</p>}
      {filtered && filtered.length === 0 && vendors && vendors.length === 0 && (
        <div className="card card-body text-center py-12 space-y-4">
          <p className="text-muted-foreground">No vendors yet.</p>
          <Link to="/vendors/new" className="btn-primary inline-block">
            Add your first vendor
          </Link>
        </div>
      )}
      {filtered && filtered.length === 0 && vendors && vendors.length > 0 && (
        <p className="text-muted-foreground text-sm">No vendors match "{search}".</p>
      )}
      {filtered && filtered.length > 0 && (
        <div className="overflow-x-auto">
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
                  <Link to={`/vendors/${v.vendor_id}`} className="text-primary-600 hover:underline">
                    {v.name}
                  </Link>
                </td>
                <td className="text-muted-foreground">{v.contact_email ?? '-'}</td>
                <td>
                  {v.tags.length === 0 ? (
                    <span className="text-muted-foreground">-</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {v.tags.map((t) => (
                        <span className="tag-chip" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="text-muted-foreground">{v.created_at.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}
