import type { ReactElement } from 'react';
import { useParams } from 'react-router-dom';

export default function VendorDetail(): ReactElement {
  const { vendorId } = useParams<{ vendorId: string }>();
  return (
    <section className="placeholder">
      <h1>Vendor detail</h1>
      <p>Coming soon. See issue #25 for the vendor detail view.</p>
      <p className="placeholder-meta">Vendor id: {vendorId ?? 'unknown'}</p>
    </section>
  );
}
