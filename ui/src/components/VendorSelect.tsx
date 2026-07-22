import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '../auth/useApiFetch';
import { listVendors } from '../api/vendors';

const CREATE_SENTINEL = '__create_new__';

interface Props {
  value: string;
  onChange: (vendorId: string) => void;
  // Fired when the user picks the "+ Create new vendor…" entry. The caller
  // decides how to create one (an inline modal, or a new-screen flow).
  onCreateNew: () => void;
  disabled?: boolean;
  placeholder?: string;
  // Bump to force a refetch — e.g. after creating a vendor via a modal so
  // the new record shows up immediately.
  refreshSignal?: number;
  autoFocus?: boolean;
  ariaLabel?: string;
}

// A vendor picker backed by the live vendor list. Selecting a real entry
// reports its vendor_id; selecting the trailing "+ Create new vendor…"
// entry calls onCreateNew instead of changing the value. The list refetches
// whenever the tab regains focus, so returning from an AWS-style
// create-in-a-new-tab flow surfaces the freshly created vendor without a
// manual reload.
export default function VendorSelect({
  value,
  onChange,
  onCreateNew,
  disabled,
  placeholder = 'Select a vendor…',
  refreshSignal = 0,
  autoFocus,
  ariaLabel,
}: Props): ReactElement {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  // Shares the ['vendors'] cache with the Vendors route, so both must
  // request the same page size (500).
  const { data, error } = useQuery({
    queryKey: ['vendors'],
    queryFn: () => listVendors(apiFetch, { limit: 500 }),
  });
  const vendors = data?.vendors ?? [];
  const loadError = error ? (error as Error).message : null;

  const prevSignal = useRef(refreshSignal);
  useEffect(() => {
    if (prevSignal.current !== refreshSignal) {
      prevSignal.current = refreshSignal;
      void queryClient.invalidateQueries({ queryKey: ['vendors'] });
    }
  }, [refreshSignal, queryClient]);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void queryClient.invalidateQueries({ queryKey: ['vendors'] });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [queryClient]);

  // The bound vendor may be missing from the fetched page (deleted, or the
  // list is capped). Show a synthetic entry so the control still reflects it.
  const known = vendors.some((v) => v.vendor_id === value);

  return (
    <div>
      <select
        className="input"
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={ariaLabel ?? 'Vendor'}
        onChange={(e) => {
          const next = e.target.value;
          if (next === CREATE_SENTINEL) {
            onCreateNew();
            return;
          }
          onChange(next);
        }}
      >
        <option value="">{placeholder}</option>
        {value && !known && <option value={value}>{value}</option>}
        {vendors.map((v) => (
          <option key={v.vendor_id} value={v.vendor_id}>
            {v.name}
          </option>
        ))}
        <option value={CREATE_SENTINEL}>+ Create new vendor…</option>
      </select>
      {loadError && (
        <p className="text-xs text-error-600 mt-1">Could not load vendors: {loadError}</p>
      )}
    </div>
  );
}
