import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { ApiError, type ApiFetch } from '../auth/useApiFetch';
import {
  requestBriefUploadUrl,
  submitChatBrief,
  submitPdfBrief,
  uploadPdf,
} from '../api/briefs';
import { updateCampaign } from '../api/campaigns';
import type {
  BriefResponse,
  Campaign,
  CampaignBrief,
  CampaignStatus,
  ChatEntry,
  UpdateCampaignRequest,
} from '../api/types';
import SourcePicker from './SourcePicker';
import WarningsBanner from './WarningsBanner';
import KeyValueEditor from './KeyValueEditor';
import { objectToPairs, pairsToObject } from './kvUtils';

interface Props {
  apiFetch: ApiFetch;
  campaign: Campaign;
  brief: CampaignBrief | null;
  onBriefChange: (brief: CampaignBrief) => void;
  onCampaignChange: (campaign: Campaign) => void;
}

export default function CampaignBriefSection({
  apiFetch,
  campaign,
  brief,
  onBriefChange,
  onCampaignChange,
}: Props): ReactElement {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const finishSubmit = (result: BriefResponse): void => {
    onBriefChange({
      source_type: result.source_type,
      summary: result.summary,
      suggested_campaign: result.suggested_campaign,
      warnings: result.warnings,
      raw: null,
      created_at: new Date().toISOString(),
    });
    setAdding(false);
  };

  const handleChatSubmit = async (conversation: ChatEntry[]): Promise<void> => {
    setBusy(true);
    setSubmitError(null);
    try {
      finishSubmit(await submitChatBrief(apiFetch, campaign.campaign_id, conversation));
    } catch (err) {
      setSubmitError(formatBriefError(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePdfSubmit = async (file: File): Promise<void> => {
    setBusy(true);
    setSubmitError(null);
    try {
      const upload = await requestBriefUploadUrl(apiFetch, campaign.campaign_id);
      await uploadPdf(upload.upload_url, file);
      finishSubmit(await submitPdfBrief(apiFetch, campaign.campaign_id));
    } catch (err) {
      setSubmitError(formatBriefError(err));
    } finally {
      setBusy(false);
    }
  };

  const showPicker = adding || !brief;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">Brief</h2>
        {brief && !adding && (
          <button type="button" className="btn-link" onClick={() => setAdding(true)}>
            Replace brief
          </button>
        )}
      </div>

      {showPicker && (
        <div className="space-y-3">
          <p className="text-muted-foreground max-w-2xl">
            Upload a vendor brief PDF or paste the conversation. The model produces a structured
            summary and suggested fields you can apply to this campaign.
          </p>
          {submitError && <p className="form-error">{submitError}</p>}
          <SourcePicker
            busy={busy}
            onSubmitChat={(c) => void handleChatSubmit(c)}
            onSubmitPdf={(f) => void handlePdfSubmit(f)}
          />
          {brief && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setSubmitError(null);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {brief && !adding && (
        <BriefSummary
          key={brief.created_at}
          apiFetch={apiFetch}
          campaign={campaign}
          brief={brief}
          onCampaignChange={onCampaignChange}
        />
      )}
    </section>
  );
}

interface SummaryProps {
  apiFetch: ApiFetch;
  campaign: Campaign;
  brief: CampaignBrief;
  onCampaignChange: (campaign: Campaign) => void;
}

interface ApplyState {
  name: string;
  sponsor: string;
  startDate: string;
  endDate: string;
  status: CampaignStatus;
  payoutAmount: string;
  payoutCurrency: string;
  payoutPaid: boolean;
  targetMetricsPairs: { key: string; value: string }[];
}

function BriefSummary({ apiFetch, campaign, brief, onCampaignChange }: SummaryProps): ReactElement {
  const initial = useMemo<ApplyState>(() => seedApplyState(campaign, brief), [campaign, brief]);
  const [form, setForm] = useState<ApplyState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [copied, setCopied] = useState(false);

  const update = <K extends keyof ApplyState>(key: K, value: ApplyState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
    setApplied(false);
  };

  const deliverables = brief.suggested_campaign?.deliverables ?? [];

  const copySummary = (): void => {
    void navigator.clipboard.writeText(brief.summary).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const apply = async (): Promise<void> => {
    setError(null);
    const payload: UpdateCampaignRequest = {};

    const name = form.name.trim();
    if (name.length > 0) payload.name = name;
    payload.sponsor = form.sponsor.trim();
    payload.status = form.status;
    if (form.startDate) payload.startDate = form.startDate;
    if (form.endDate) payload.endDate = form.endDate;

    const amount = form.payoutAmount.trim();
    if (amount.length > 0) {
      const num = Number(amount);
      if (!Number.isFinite(num) || num < 0) {
        setError('Payout amount must be a non-negative number.');
        return;
      }
      payload.payout = {
        amount: num,
        currency: form.payoutCurrency.toUpperCase() || 'USD',
        paid: form.payoutPaid,
      };
    }

    const targetMetrics = pairsToObject(form.targetMetricsPairs);
    if (Object.keys(targetMetrics).length > 0) payload.targetMetrics = targetMetrics;

    setBusy(true);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, payload);
      onCampaignChange(updated);
      setApplied(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="card card-body space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold text-foreground">Summary</h3>
            <span className="text-xs text-muted-foreground">
              {brief.source_type === 'pdf' ? 'from PDF' : 'from chat'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {brief.raw?.download_url && (
              <a href={brief.raw.download_url} target="_blank" rel="noreferrer" className="btn-link">
                Download original
              </a>
            )}
            <button type="button" className="btn-link" onClick={copySummary}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        <p className="text-sm text-foreground whitespace-pre-wrap">{brief.summary}</p>
      </section>

      <WarningsBanner warnings={brief.warnings} />

      {deliverables.length > 0 && (
        <section className="card card-body space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Deliverables</h3>
          <ul className="space-y-1 text-sm text-foreground">
            {deliverables.map((d, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <span className="font-medium">
                  {d.count && d.count > 1 ? `${d.count}× ` : ''}
                  {d.platform} {d.type}
                </span>
                {d.notes && <span className="text-muted-foreground">— {d.notes}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card card-body space-y-4">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold text-foreground">Suggested updates</h3>
          <span className="text-xs text-muted-foreground">Edit, then apply to this campaign.</span>
        </div>

        <label className="block">
          <span className="field-label">Name</span>
          <input
            type="text"
            className="input"
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="block">
          <span className="field-label">Sponsor</span>
          <input
            type="text"
            className="input"
            value={form.sponsor}
            onChange={(e) => update('sponsor', e.target.value)}
            disabled={busy}
            placeholder="Vendor / brand name"
          />
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block">
            <span className="field-label">Start date</span>
            <input
              type="date"
              className="input"
              value={form.startDate}
              onChange={(e) => update('startDate', e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="field-label">End date</span>
            <input
              type="date"
              className="input"
              value={form.endDate}
              onChange={(e) => update('endDate', e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="field-label">Status</span>
            <select
              className="input"
              value={form.status}
              onChange={(e) => update('status', e.target.value as CampaignStatus)}
              disabled={busy}
            >
              <option value="draft">draft</option>
              <option value="active">active</option>
              <option value="completed">completed</option>
            </select>
          </label>
        </div>

        <fieldset className="border border-border rounded-lg px-4 py-3 space-y-2">
          <legend className="px-1 text-sm font-medium text-foreground">Payout</legend>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block">
              <span className="field-label">Amount</span>
              <input
                type="number"
                min={0}
                step="0.01"
                className="input"
                value={form.payoutAmount}
                onChange={(e) => update('payoutAmount', e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="block">
              <span className="field-label">Currency</span>
              <input
                type="text"
                className="input"
                value={form.payoutCurrency}
                maxLength={3}
                placeholder="USD"
                onChange={(e) => update('payoutCurrency', e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="flex items-center gap-2 mt-6">
              <input
                type="checkbox"
                className="rounded border-border text-primary-600 focus:ring-primary-500"
                checked={form.payoutPaid}
                onChange={(e) => update('payoutPaid', e.target.checked)}
                disabled={busy}
              />
              <span className="text-sm text-foreground">Already paid</span>
            </label>
          </div>
          <p className="field-hint">Leave amount blank to leave the payout unchanged.</p>
        </fieldset>

        <fieldset className="border border-border rounded-lg px-4 py-3 space-y-2">
          <legend className="px-1 text-sm font-medium text-foreground">Target metrics</legend>
          <KeyValueEditor
            pairs={form.targetMetricsPairs}
            onChange={(pairs) => update('targetMetricsPairs', pairs)}
            keyPlaceholder="metric (impressions, ctr, ...)"
            valuePlaceholder="value"
          />
        </fieldset>

        {error && <p className="form-error">{error}</p>}

        <div className="flex items-center justify-end gap-3">
          {applied && <span className="text-sm text-success-700">Applied.</span>}
          <button type="button" className="btn-primary" onClick={() => void apply()} disabled={busy}>
            {busy ? 'Applying...' : 'Apply to campaign'}
          </button>
        </div>
      </section>
    </div>
  );
}

function seedApplyState(campaign: Campaign, brief: CampaignBrief): ApplyState {
  const sc = brief.suggested_campaign ?? {};
  const payoutAmount = sc.payout?.amount ?? campaign.payout?.amount;
  return {
    name: sc.name ?? campaign.name,
    sponsor: sc.vendor?.name_hint ?? campaign.sponsor ?? '',
    startDate: sc.startDate ?? campaign.startDate ?? '',
    endDate: sc.endDate ?? campaign.endDate ?? '',
    status: campaign.status,
    payoutAmount: typeof payoutAmount === 'number' ? String(payoutAmount) : '',
    payoutCurrency: sc.payout?.currency ?? campaign.payout?.currency ?? 'USD',
    payoutPaid: campaign.payout?.paid ?? false,
    targetMetricsPairs: objectToPairs(sc.targetMetrics ?? campaign.targetMetrics ?? undefined),
  };
}

function formatBriefError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 502) {
      return `The model couldn't parse the brief. Try again or simplify the input. (${err.message})`;
    }
    if (err.status === 413) {
      return 'The brief is too large for the API.';
    }
    if (err.status === 0) {
      return 'Network error. Check your connection and retry.';
    }
    return err.message;
  }
  return (err as Error).message;
}
