import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import type { BriefResponse, ConfirmRequest, Deliverable } from '../api/types';
import DeliverablesEditor from './DeliverablesEditor';
import VendorAutocomplete from './VendorAutocomplete';
import KeyValueEditor from './KeyValueEditor';
import { objectToPairs, pairsToObject } from './kvUtils';
import WarningsBanner from './WarningsBanner';

interface Props {
  brief: BriefResponse;
  busy: boolean;
  serverError: string | null;
  onConfirm: (payload: ConfirmRequest) => void;
  onDiscard: () => void;
}

type Status = 'draft' | 'active' | 'completed';

interface FormState {
  name: string;
  vendorId: string;
  vendorName: string;
  startDate: string;
  endDate: string;
  status: Status;
  deliverables: Deliverable[];
  payoutAmount: string;
  payoutCurrency: string;
  payoutPaid: boolean;
  targetMetricsPairs: { key: string; value: string }[];
}

export default function ReviewForm({
  brief,
  busy,
  serverError,
  onConfirm,
  onDiscard,
}: Props): ReactElement {
  const initial = useMemo<FormState>(() => stateFromBrief(brief), [brief]);
  const [form, setForm] = useState<FormState>(initial);
  const [copyConfirm, setCopyConfirm] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const copySummary = (): void => {
    void navigator.clipboard.writeText(brief.summary).then(() => {
      setCopyConfirm(true);
      setTimeout(() => setCopyConfirm(false), 1500);
    });
  };

  const submit = (): void => {
    setValidationError(null);
    const name = form.name.trim();
    if (name.length === 0) {
      setValidationError('Name is required.');
      return;
    }

    const payload: ConfirmRequest = { name, status: form.status };

    if (form.vendorId) {
      payload.vendor_id = form.vendorId;
    } else if (form.vendorName.trim().length > 0) {
      payload.sponsor = form.vendorName.trim();
    }

    if (form.startDate) payload.startDate = form.startDate;
    if (form.endDate) payload.endDate = form.endDate;

    const cleanedDeliverables = form.deliverables
      .map((d) => ({
        platform: d.platform.trim(),
        type: d.type.trim(),
        count: d.count,
        notes: d.notes?.trim() ?? '',
      }))
      .filter((d) => d.platform.length > 0 && d.type.length > 0);
    if (cleanedDeliverables.length > 0) {
      payload.deliverables = cleanedDeliverables.map((d) => ({
        platform: d.platform,
        type: d.type,
        count: d.count,
        ...(d.notes.length > 0 ? { notes: d.notes } : {}),
      }));
    }

    const amount = form.payoutAmount.trim();
    if (amount.length > 0) {
      const num = Number(amount);
      if (!Number.isFinite(num) || num < 0) {
        setValidationError('Payout amount must be a non-negative number.');
        return;
      }
      payload.payout = {
        amount: num,
        currency: form.payoutCurrency.toUpperCase() || 'USD',
        paid: form.payoutPaid,
      };
    }

    const targetMetrics = pairsToObject(form.targetMetricsPairs);
    if (Object.keys(targetMetrics).length > 0) {
      payload.targetMetrics = targetMetrics;
    }

    onConfirm(payload);
  };

  return (
    <div className="review-form">
      <section className="summary-panel">
        <div className="summary-header">
          <h2>Summary</h2>
          <button type="button" className="link-button" onClick={copySummary}>
            {copyConfirm ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="summary-body">{brief.summary}</p>
      </section>

      <WarningsBanner warnings={brief.warnings} />

      <section className="campaign-form">
        <h2>Campaign details</h2>

        <label className="field">
          <span className="field-label">Name</span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="field">
          <span className="field-label">Vendor</span>
          <VendorAutocomplete
            vendorId={form.vendorId}
            vendorName={form.vendorName}
            onChange={(sel) =>
              setForm((f) => ({ ...f, vendorId: sel.vendorId, vendorName: sel.vendorName }))
            }
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field-label">Start date</span>
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => update('startDate', e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            <span className="field-label">End date</span>
            <input
              type="date"
              value={form.endDate}
              onChange={(e) => update('endDate', e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            <span className="field-label">Status</span>
            <select
              value={form.status}
              onChange={(e) => update('status', e.target.value as Status)}
              disabled={busy}
            >
              <option value="draft">draft</option>
              <option value="active">active</option>
              <option value="completed">completed</option>
            </select>
          </label>
        </div>

        <fieldset className="form-section">
          <legend>Deliverables</legend>
          <DeliverablesEditor
            deliverables={form.deliverables}
            onChange={(d) => update('deliverables', d)}
          />
        </fieldset>

        <fieldset className="form-section">
          <legend>Payout</legend>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Amount</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.payoutAmount}
                onChange={(e) => update('payoutAmount', e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="field">
              <span className="field-label">Currency</span>
              <input
                type="text"
                value={form.payoutCurrency}
                maxLength={3}
                placeholder="USD"
                onChange={(e) => update('payoutCurrency', e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="field field-inline">
              <input
                type="checkbox"
                checked={form.payoutPaid}
                onChange={(e) => update('payoutPaid', e.target.checked)}
                disabled={busy}
              />
              <span className="field-label">Already paid</span>
            </label>
          </div>
          <p className="field-hint">Leave amount blank to skip recording a payout.</p>
        </fieldset>

        <fieldset className="form-section">
          <legend>Target metrics</legend>
          <KeyValueEditor
            pairs={form.targetMetricsPairs}
            onChange={(pairs) => update('targetMetricsPairs', pairs)}
            keyPlaceholder="metric (impressions, ctr, ...)"
            valuePlaceholder="value"
          />
        </fieldset>

        {validationError && <p className="form-error">{validationError}</p>}
        {serverError && <p className="form-error">{serverError}</p>}

        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            onClick={onDiscard}
            disabled={busy}
          >
            Discard
          </button>
          <button type="button" className="primary" onClick={submit} disabled={busy}>
            {busy ? 'Creating campaign...' : 'Create campaign'}
          </button>
        </div>
      </section>
    </div>
  );
}

function stateFromBrief(brief: BriefResponse): FormState {
  const sc = brief.suggested_campaign ?? {};
  return {
    name: sc.name ?? '',
    vendorId: sc.vendor_id ?? '',
    vendorName: sc.vendor?.name_hint ?? '',
    startDate: sc.startDate ?? '',
    endDate: sc.endDate ?? '',
    status: 'draft',
    deliverables: (sc.deliverables ?? []).map((d) => ({
      platform: d.platform,
      type: d.type,
      count: d.count ?? 1,
      notes: d.notes ?? '',
    })),
    payoutAmount:
      typeof sc.payout?.amount === 'number' ? String(sc.payout.amount) : '',
    payoutCurrency: sc.payout?.currency ?? 'USD',
    payoutPaid: false,
    targetMetricsPairs: objectToPairs(sc.targetMetrics),
  };
}
