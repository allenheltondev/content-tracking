import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import { getVendor, updateVendor } from '../api/vendors';
import type { Vendor, VendorPayload } from '../api/types';
import VendorForm from '../components/VendorForm';

export default function VendorEdit(): ReactElement {
  const { vendorId } = useParams<{ vendorId: string }>();
  const apiFetch = useApiFetch();
  const navigate = useNavigate();
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!vendorId) return;
    let cancelled = false;
    getVendor(apiFetch, vendorId)
      .then((res) => {
        if (!cancelled) setVendor(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, vendorId]);

  const handleSubmit = async (payload: VendorPayload): Promise<void> => {
    if (!vendorId) return;
    setBusy(true);
    setServerError(null);
    try {
      await updateVendor(apiFetch, vendorId, payload);
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
