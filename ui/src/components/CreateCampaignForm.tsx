import type { ReactElement } from 'react';
import { useState } from 'react';
import type { CampaignStatus, CreateCampaignRequest } from '../api/types';
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

export default function CreateCampaignForm({
  busy,
  serverError,
  onSubmit,
  onCancel,
  lockedVendorId,
}: Props): ReactElement {
  const [name, setName] = useState('');
  const [vendorId, setVendorId] = useState(lockedVendorId ?? '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState<CampaignStatus>('draft');
  const [blogUrl, setBlogUrl] = useState('');
  const [linkTrackingId, setLinkTrackingId] = useState('');
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
    }
    if (startDate) payload.startDate = startDate;
    if (endDate) payload.endDate = endDate;
    if (blogUrl.trim()) payload.blog_url = blogUrl.trim();
    if (linkTrackingId.trim()) payload.link_tracking_id = linkTrackingId.trim();
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
            <option value="monitoring">monitoring</option>
            <option value="completed">completed</option>
          </select>
        </label>
      </div>

      <label className="block">
        <span className="field-label">Blog post URL</span>
        <input
          type="url"
          className="input"
          placeholder="https://blog.example.com/my-post"
          value={blogUrl}
          onChange={(e) => setBlogUrl(e.target.value)}
          disabled={busy}
        />
        <span className="text-xs text-muted-foreground mt-1 block">
          Optional. Links this campaign to a published post for GA4 + Core Web Vitals analytics.
        </span>
      </label>

      <label className="block">
        <span className="field-label">Link tracking ID</span>
        <input
          type="text"
          className="input"
          placeholder="acme-q2-launch"
          value={linkTrackingId}
          onChange={(e) => setLinkTrackingId(e.target.value)}
          disabled={busy}
        />
        <span className="text-xs text-muted-foreground mt-1 block">
          Optional. Tags every short link minted for this campaign so the newsletter service can
          group analytics by campaign. Letters, digits, underscores, or hyphens.
        </span>
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
