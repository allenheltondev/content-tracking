import type { ReactElement } from 'react';
import { useState } from 'react';
import type { CampaignStatus, CreateCampaignRequest } from '../api/types';
import VendorAutocomplete from './VendorAutocomplete';

interface Props {
  busy: boolean;
  serverError: string | null;
  onSubmit: (payload: CreateCampaignRequest) => void;
  onCancel: () => void;
}

export default function CreateCampaignForm({
  busy,
  serverError,
  onSubmit,
  onCancel,
}: Props): ReactElement {
  const [name, setName] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState<CampaignStatus>('draft');
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = (): void => {
    setValidationError(null);
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setValidationError('Name is required.');
      return;
    }
    const payload: CreateCampaignRequest = { name: trimmed, status };
    if (vendorId) {
      payload.vendor_id = vendorId;
    } else if (vendorName.trim().length > 0) {
      payload.sponsor = vendorName.trim();
    }
    if (startDate) payload.startDate = startDate;
    if (endDate) payload.endDate = endDate;
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
        <VendorAutocomplete
          vendorId={vendorId}
          vendorName={vendorName}
          onChange={(sel) => {
            setVendorId(sel.vendorId);
            setVendorName(sel.vendorName);
          }}
        />
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block">
          <span className="field-label">Start date</span>
          <input
            type="date"
            className="input"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="block">
          <span className="field-label">End date</span>
          <input
            type="date"
            className="input"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="block">
          <span className="field-label">Status</span>
          <select
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as CampaignStatus)}
            disabled={busy}
          >
            <option value="draft">draft</option>
            <option value="active">active</option>
            <option value="completed">completed</option>
          </select>
        </label>
      </div>

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
