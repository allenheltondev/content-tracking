import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useApiFetch } from '../auth/useApiFetch';
import { listVendors } from '../api/vendors';
import type { Vendor } from '../api/types';

interface Props {
  vendorId: string;
  vendorName: string;
  onChange: (selection: { vendorId: string; vendorName: string }) => void;
}

// Combobox-style: free-text input filtered against the live vendor list.
// Selecting a suggestion binds the vendor_id (typed selection); typing a
// new name leaves vendor_id empty so the server falls back to the sponsor
// string. Either path is fine — vendor_id is optional in the API.
export default function VendorAutocomplete({ vendorId, vendorName, onChange }: Props): ReactElement {
  const apiFetch = useApiFetch();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listVendors(apiFetch, { limit: 200 })
      .then((res) => {
        if (!cancelled) setVendors(res.vendors);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  const matches = useMemo(() => {
    const needle = vendorName.trim().toLowerCase();
    if (needle.length === 0) return vendors.slice(0, 8);
    return vendors
      .filter((v) => v.name.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [vendors, vendorName]);

  const exactMatch = useMemo(
    () => vendors.find((v) => v.name.toLowerCase() === vendorName.trim().toLowerCase()),
    [vendors, vendorName],
  );

  return (
    <div className="relative">
      <input
        type="text"
        className="input"
        value={vendorName}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay so an option click registers before the list closes.
          setTimeout(() => setOpen(false), 150);
        }}
        onChange={(e) => {
          // Editing the text breaks any prior vendor_id binding.
          onChange({ vendorId: '', vendorName: e.target.value });
        }}
        placeholder="Vendor name"
      />
      {vendorId && exactMatch && (
        <p className="text-xs text-muted-foreground mt-1">Bound to vendor: {exactMatch.name}</p>
      )}
      {!vendorId && vendorName.trim().length > 0 && (
        <p className="text-xs text-muted-foreground mt-1">Free-text sponsor (no vendor record).</p>
      )}
      {loadError && (
        <p className="text-xs text-error-600 mt-1">Could not load vendor list: {loadError}</p>
      )}
      {open && matches.length > 0 && (
        <ul
          className="absolute top-full left-0 right-0 z-10 mt-1 max-h-60 overflow-y-auto bg-surface border border-border rounded-lg shadow-medium"
          role="listbox"
        >
          {matches.map((v) => (
            <li key={v.vendor_id}>
              <button
                type="button"
                className="block w-full text-left px-3 py-1.5 text-sm hover:bg-muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange({ vendorId: v.vendor_id, vendorName: v.name });
                  setOpen(false);
                }}
              >
                {v.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
