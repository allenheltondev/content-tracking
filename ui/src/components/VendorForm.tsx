import type { ReactElement } from 'react';
import { useState } from 'react';
import type { Vendor, VendorPayload } from '../api/types';
import TagsInput from './TagsInput';

interface Props {
  initial?: Vendor | null;
  busy: boolean;
  serverError: string | null;
  submitLabel?: string;
  onSubmit: (payload: VendorPayload) => void;
  onCancel: () => void;
}

interface FormState {
  vendor_id: string;
  name: string;
  website: string;
  contact_name: string;
  contact_email: string;
  payment_terms: string;
  tags: string[];
  notes: string;
}

// Vendor-ID slug rules: lowercase, spaces → underscores, drop anything
// outside [a-z0-9_-]. Mirrors the backend's VENDOR_ID_RE so the value
// the user sees in the field is always submittable as-is.
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '');
}

const VENDOR_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

export default function VendorForm({
  initial,
  busy,
  serverError,
  submitLabel = 'Save vendor',
  onSubmit,
  onCancel,
}: Props): ReactElement {
  const isUpdate = !!initial;
  const [form, setForm] = useState<FormState>(() => stateFromVendor(initial));
  // Tracks whether the user has explicitly edited the vendor_id input. If
  // they have, stop auto-syncing it from the name. If they clear it back
  // out, name-sync resumes.
  const [idDirty, setIdDirty] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleNameChange = (value: string): void => {
    setForm((f) => ({
      ...f,
      name: value,
      vendor_id: !isUpdate && !idDirty ? slugifyName(value) : f.vendor_id,
    }));
  };

  const handleIdChange = (value: string): void => {
    setIdDirty(value.length > 0);
    setForm((f) => ({ ...f, vendor_id: value }));
  };

  const submit = (): void => {
    setValidationError(null);
    const name = form.name.trim();
    if (name.length === 0) {
      setValidationError('Name is required.');
      return;
    }
    const vendorId = form.vendor_id.trim();
    if (!isUpdate) {
      if (vendorId.length === 0) {
        setValidationError('Vendor ID is required.');
        return;
      }
      if (!VENDOR_ID_RE.test(vendorId)) {
        setValidationError(
          'Vendor ID can only contain letters, digits, underscores, and hyphens (max 80).',
        );
        return;
      }
    }
    const website = form.website.trim();
    if (website.length > 0 && !/^https?:\/\//i.test(website)) {
      setValidationError('Website must start with http:// or https://.');
      return;
    }
    const email = form.contact_email.trim();
    if (email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setValidationError('Contact email must look like an email address.');
      return;
    }

    const payload: VendorPayload = { name };
    if (!isUpdate) {
      payload.vendor_id = vendorId;
    }
    // For each optional field: empty string means "clear on edit, omit on
    // create". We use null on edit so the API REMOVEs it, and undefined
    // on create to leave it absent. The route differentiates via initial.
    setStringField(payload, 'website', website, isUpdate);
    setStringField(payload, 'contact_name', form.contact_name.trim(), isUpdate);
    setStringField(payload, 'contact_email', email, isUpdate);
    setStringField(payload, 'payment_terms', form.payment_terms.trim(), isUpdate);
    setStringField(payload, 'notes', form.notes.trim(), isUpdate);
    if (form.tags.length > 0 || isUpdate) {
      payload.tags = form.tags;
    }

    onSubmit(payload);
  };

  return (
    <div className="card card-body space-y-3 max-w-2xl">
      <label className="block">
        <span className="field-label">Name</span>
        <input
          type="text"
          className="input"
          value={form.name}
          onChange={(e) => handleNameChange(e.target.value)}
          disabled={busy}
          autoFocus={!initial}
        />
      </label>

      {!isUpdate && (
        <label className="block">
          <span className="field-label">Vendor ID</span>
          <input
            type="text"
            className="input font-mono"
            value={form.vendor_id}
            onChange={(e) => handleIdChange(e.target.value)}
            disabled={busy}
            placeholder="auto-generated from name"
            spellCheck={false}
          />
          <span className="text-xs text-muted-foreground mt-1 block">
            Permanent. Used in URLs. Lowercase letters, digits, underscores, or hyphens.
          </span>
        </label>
      )}

      <label className="block">
        <span className="field-label">Website</span>
        <input
          type="url"
          className="input"
          value={form.website}
          onChange={(e) => update('website', e.target.value)}
          placeholder="https://example.com"
          disabled={busy}
        />
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="field-label">Contact name</span>
          <input
            type="text"
            className="input"
            value={form.contact_name}
            onChange={(e) => update('contact_name', e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="block">
          <span className="field-label">Contact email</span>
          <input
            type="email"
            className="input"
            value={form.contact_email}
            onChange={(e) => update('contact_email', e.target.value)}
            disabled={busy}
          />
        </label>
      </div>

      <label className="block">
        <span className="field-label">Payment terms</span>
        <input
          type="text"
          className="input"
          value={form.payment_terms}
          onChange={(e) => update('payment_terms', e.target.value)}
          placeholder="Net 30, paid on publish, ..."
          disabled={busy}
        />
      </label>

      <label className="block">
        <span className="field-label">Tags</span>
        <TagsInput tags={form.tags} onChange={(tags) => update('tags', tags)} disabled={busy} />
      </label>

      <label className="block">
        <span className="field-label">Notes</span>
        <textarea
          rows={4}
          className="input"
          value={form.notes}
          onChange={(e) => update('notes', e.target.value)}
          disabled={busy}
        />
      </label>

      {validationError && <p className="form-error">{validationError}</p>}
      {serverError && <p className="form-error">{serverError}</p>}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving...' : submitLabel}
        </button>
      </div>
    </div>
  );
}

function stateFromVendor(v: Vendor | null | undefined): FormState {
  return {
    vendor_id: v?.vendor_id ?? '',
    name: v?.name ?? '',
    website: v?.website ?? '',
    contact_name: v?.contact_name ?? '',
    contact_email: v?.contact_email ?? '',
    payment_terms: v?.payment_terms ?? '',
    tags: v?.tags ?? [],
    notes: v?.notes ?? '',
  };
}

function setStringField(
  payload: VendorPayload,
  key: 'website' | 'contact_name' | 'contact_email' | 'payment_terms' | 'notes',
  value: string,
  isUpdate: boolean,
): void {
  if (value.length > 0) {
    payload[key] = value;
  } else if (isUpdate) {
    payload[key] = null;
  }
}
