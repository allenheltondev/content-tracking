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
      <section className="vendor-edit">
        <h1>Vendor not found</h1>
        <p className="form-error">{loadError}</p>
        <Link to="/vendors">Back to vendors</Link>
      </section>
    );
  }

  if (!vendor) {
    return (
      <section className="vendor-edit">
        <h1>Edit vendor</h1>
        <p>Loading...</p>
      </section>
    );
  }

  return (
    <section className="vendor-edit">
      <header className="page-header">
        <h1>Edit {vendor.name}</h1>
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
