import type { ReactElement } from 'react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import { getVendor, updateVendor } from '../api/vendors';
import type { VendorPayload } from '../api/types';
import VendorForm from '../components/VendorForm';

export default function VendorEdit(): ReactElement {
  const { vendorId } = useParams<{ vendorId: string }>();
  const apiFetch = useApiFetch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const { data, error: queryError } = useQuery({
    queryKey: ['vendor', vendorId],
    queryFn: () => getVendor(apiFetch, vendorId!),
    enabled: Boolean(vendorId),
  });
  const vendor = data ?? null;
  const loadError = queryError ? (queryError as Error).message : null;

  const handleSubmit = async (payload: VendorPayload): Promise<void> => {
    if (!vendorId) return;
    setBusy(true);
    setServerError(null);
    try {
      const updated = await updateVendor(apiFetch, vendorId, payload);
      queryClient.setQueryData(['vendor', vendorId], updated);
      void queryClient.invalidateQueries({ queryKey: ['vendors'] });
      navigate(`/vendors/${vendorId}`);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">Vendor not found</h1>
        <p className="form-error">{loadError}</p>
        <Link to="/vendors" className="btn-link">
          Back to vendors
        </Link>
      </section>
    );
  }

  if (!vendor) {
    return (
      <section>
        <h1 className="text-2xl font-semibold">Edit vendor</h1>
        <p className="text-muted-foreground">Loading...</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">Edit {vendor.name}</h1>
      </header>
      <VendorForm
        initial={vendor}
        busy={busy}
        serverError={serverError}
        submitLabel="Save changes"
        onSubmit={(p) => void handleSubmit(p)}
        onCancel={() => navigate(`/vendors/${vendor.vendor_id}`)}
      />
    </section>
  );
}
