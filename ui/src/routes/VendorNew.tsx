import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import { createVendor } from '../api/vendors';
import type { VendorPayload } from '../api/types';
import VendorForm from '../components/VendorForm';

export default function VendorNew(): ReactElement {
  const apiFetch = useApiFetch();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const handleSubmit = async (payload: VendorPayload): Promise<void> => {
    setBusy(true);
    setServerError(null);
    try {
      const vendor = await createVendor(apiFetch, payload);
      navigate(`/vendors/${vendor.vendor_id}`);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">New vendor</h1>
      </header>
      <VendorForm
        busy={busy}
        serverError={serverError}
        submitLabel="Create vendor"
        onSubmit={(p) => void handleSubmit(p)}
        onCancel={() => navigate('/vendors')}
      />
    </section>
  );
}
