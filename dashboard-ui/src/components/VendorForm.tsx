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
  name: string;
  website: string;
  contact_name: string;
  contact_email: string;
  payment_terms: string;
  tags: string[];
  notes: string;
}

export default function VendorForm({
  initial,
  busy,
  serverError,
  submitLabel = 'Save vendor',
  onSubmit,
  onCancel,
}: Props): ReactElement {
  const [form, setForm] = useState<FormState>(() => stateFromVendor(initial));
  const [validationError, setValidationError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const submit = (): void => {
    setValidationError(null);
    const name = form.name.trim();
    if (name.length === 0) {
      setValidationError('Name is required.');
      return;
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
    // For each optional field: empty string means "clear on edit, omit on
    // create". We use null on edit so the API REMOVEs it, and undefined
    // on create to leave it absent. The route differentiates via initial.
    const isUpdate = !!initial;
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
    <div className="vendor-form">
      <label className="field">
        <span className="field-label">Name</span>
        <input
          type="text"
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
          disabled={busy}
          autoFocus={!initial}
        />
      </label>

      <label className="field">
        <span className="field-label">Website</span>
        <input
          type="url"
          value={form.website}
          onChange={(e) => update('website', e.target.value)}
          placeholder="https://example.com"
          disabled={busy}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span className="field-label">Contact name</span>
          <input
            type="text"
            value={form.contact_name}
            onChange={(e) => update('contact_name', e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="field">
          <span className="field-label">Contact email</span>
          <input
            type="email"
            value={form.contact_email}
            onChange={(e) => update('contact_email', e.target.value)}
            disabled={busy}
          />
        </label>
      </div>

      <label className="field">
        <span className="field-label">Payment terms</span>
        <input
          type="text"
          value={form.payment_terms}
          onChange={(e) => update('payment_terms', e.target.value)}
          placeholder="Net 30, paid on publish, ..."
          disabled={busy}
        />
      </label>

      <label className="field">
        <span className="field-label">Tags</span>
        <TagsInput
          tags={form.tags}
          onChange={(tags) => update('tags', tags)}
          disabled={busy}
        />
      </label>

      <label className="field">
        <span className="field-label">Notes</span>
        <textarea
          rows={4}
          value={form.notes}
          onChange={(e) => update('notes', e.target.value)}
          disabled={busy}
        />
      </label>

      {validationError && <p className="form-error">{validationError}</p>}
      {serverError && <p className="form-error">{serverError}</p>}

      <div className="form-actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving...' : submitLabel}
        </button>
      </div>
    </div>
  );
}

function stateFromVendor(v: Vendor | null | undefined): FormState {
  return {
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
