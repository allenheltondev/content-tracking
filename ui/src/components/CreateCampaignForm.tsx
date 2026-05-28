import type { ReactElement } from 'react';
import { useState } from 'react';
import type { CreateCampaignRequest } from '../api/types';
import VendorSelect from './VendorSelect';

interface Props {
  busy: boolean;
  serverError: string | null;
  onSubmit: (payload: CreateCampaignRequest) => void;
  onCancel: () => void;
  // When set, the vendor field is pre-filled with this id and locked so the
  // user can't change it — used by the "Add campaign" flow on a vendor page.
  lockedVendorId?: string;
}

// Intentionally minimal: only name and vendor. Everything else (dates,
// status, payout, blog URL, link tracking ID) is filled in either by the
// brief upload that immediately follows creation, or inline on the campaign
// page once it exists. The point is to get to the brief upload as fast as
// possible.
export default function CreateCampaignForm({
  busy,
  serverError,
  onSubmit,
  onCancel,
  lockedVendorId,
}: Props): ReactElement {
  const [name, setName] = useState('');
  const [vendorId, setVendorId] = useState(lockedVendorId ?? '');
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = (): void => {
    setValidationError(null);
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setValidationError('Name is required.');
      return;
    }
    const payload: CreateCampaignRequest = { name: trimmed };
    if (vendorId) {
      payload.vendor_id = vendorId;
    }
    onSubmit(payload);
  };

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="field-label">Name</span>
        <input
          type="text"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          autoFocus
        />
      </label>

      <label className="block">
        <span className="field-label">Vendor</span>
        <VendorSelect
          value={vendorId}
          onChange={setVendorId}
          onCreateNew={() => window.open('/vendors/new', '_blank', 'noopener')}
          disabled={busy || Boolean(lockedVendorId)}
          ariaLabel="Vendor"
        />
        {!lockedVendorId && (
          <span className="text-xs text-muted-foreground mt-1 block">
            Pick a vendor, or choose “Create new vendor…” to add one in a new tab — it appears
            here when you return.
          </span>
        )}
      </label>

      {validationError && <p className="form-error">{validationError}</p>}
      {serverError && <p className="form-error">{serverError}</p>}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Creating...' : 'Create campaign'}
        </button>
      </div>
    </div>
  );
}
