import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, type ApiFetch } from '../../auth/useApiFetch';
import { updateCampaign } from '../../api/campaigns';
import type { Campaign, CampaignStatus, DeliverableType, VendorPayload } from '../../api/types';
import { createVendor } from '../../api/vendors';
import Modal from '../../components/Modal';
import VendorForm from '../../components/VendorForm';
import VendorSelect from '../../components/VendorSelect';

// Inline field editors for the Overview tab. Each one autosaves through
// PATCH /campaigns/:id and reports through the shared SaveIndicator.

interface EditScaffoldProps {
  editing: boolean;
  busy: boolean;
  error: string | null;
  hasValue: boolean;
  display: ReactElement;
  form: ReactElement;
  onStart: () => void;
  onCancel: () => void;
  onSave: () => void;
  emptyLabel?: string;
}

function EditScaffold({
  editing,
  busy,
  error,
  hasValue,
  display,
  form,
  onStart,
  onCancel,
  onSave,
  emptyLabel = 'Not set',
}: EditScaffoldProps): ReactElement {
  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2 flex-wrap">
        {hasValue ? display : <span className="text-muted-foreground italic">{emptyLabel}</span>}
        <EditIconButton onClick={onStart} label={hasValue ? 'Edit' : 'Add'} />
      </span>
    );
  }
  return (
    <div className="space-y-2">
      {form}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary py-1 text-sm"
          onClick={onSave}
          disabled={busy}
        >
          {busy ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          className="btn btn-secondary py-1 text-sm"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

interface FieldEditorProps {
  apiFetch: ApiFetch;
  campaign: Campaign;
  onCampaignChange: (campaign: Campaign) => void;
}

export function NameEditor({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(campaign.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (): void => {
    setValue(campaign.name);
    setError(null);
    setEditing(true);
  };
  const cancel = (): void => {
    setEditing(false);
    setError(null);
  };
  const save = async (): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setError('Name is required.');
      return;
    }
    if (trimmed === campaign.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, { name: trimmed });
      onCampaignChange(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditScaffold
      editing={editing}
      busy={busy}
      error={error}
      hasValue
      onStart={start}
      onCancel={cancel}
      onSave={() => void save()}
      display={<h1 className="text-2xl font-semibold text-foreground">{campaign.name}</h1>}
      form={
        <input
          type="text"
          className="input text-lg"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') cancel();
          }}
        />
      }
    />
  );
}

// Links the campaign to a vendor record. Picking from the dropdown saves
// immediately; "+ Create new vendor…" opens an inline modal and links the
// freshly created vendor on save. Campaigns predating a vendor record may
// still carry a free-text `sponsor` — we show it until a vendor is linked.
export function VendorEditor({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const save = async (vendorId: string): Promise<void> => {
    if (!vendorId || vendorId === campaign.vendor_id) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, {
        vendor_id: vendorId,
      });
      onCampaignChange(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async (payload: VendorPayload): Promise<void> => {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const vendor = await createVendor(apiFetch, payload);
      setRefreshSignal((n) => n + 1);
      setModalOpen(false);
      await save(vendor.vendor_id);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setCreateBusy(false);
    }
  };

  const hasVendor = Boolean(campaign.vendor_id);

  return (
    <>
      {!editing ? (
        <span className="inline-flex items-center gap-2 flex-wrap">
          {hasVendor ? (
            <Link
              to={`/vendors/${campaign.vendor_id}`}
              className="text-primary-600 hover:underline"
            >
              {campaign.sponsor ?? campaign.vendor_id}
            </Link>
          ) : campaign.sponsor ? (
            <span className="text-muted-foreground">{campaign.sponsor}</span>
          ) : (
            <span className="text-muted-foreground italic">No vendor</span>
          )}
          <EditIconButton
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
            label={hasVendor ? 'Change vendor' : campaign.sponsor ? 'Link vendor' : 'Add vendor'}
          />
        </span>
      ) : (
        <div className="space-y-2 max-w-sm">
          <VendorSelect
            value={campaign.vendor_id ?? ''}
            onChange={(id) => void save(id)}
            onCreateNew={() => setModalOpen(true)}
            disabled={busy}
            refreshSignal={refreshSignal}
            autoFocus
            ariaLabel="Select vendor"
          />
          <div className="flex items-center gap-2">
            {busy && <span className="text-xs text-muted-foreground">Saving…</span>}
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>
      )}

      <Modal
        open={modalOpen}
        title="Create vendor"
        onClose={() => {
          if (!createBusy) {
            setModalOpen(false);
            setCreateError(null);
          }
        }}
      >
        <VendorForm
          busy={createBusy}
          serverError={createError}
          submitLabel="Create vendor"
          onSubmit={(p) => void handleCreate(p)}
          onCancel={() => {
            setModalOpen(false);
            setCreateError(null);
          }}
        />
      </Modal>
    </>
  );
}

interface AutoSaveState {
  saving: boolean;
  saved: boolean;
  error: string | null;
}

function useAutoSave(): {
  state: AutoSaveState;
  run: (action: () => Promise<void>) => Promise<void>;
  setError: (message: string | null) => void;
} {
  const [state, setState] = useState<AutoSaveState>({ saving: false, saved: false, error: null });

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setState({ saving: true, saved: false, error: null });
    try {
      await action();
      setState({ saving: false, saved: true, error: null });
      setTimeout(() => {
        setState((prev) => (prev.saved ? { ...prev, saved: false } : prev));
      }, 1500);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      setState({ saving: false, saved: false, error: message });
    }
  }, []);

  const setError = useCallback((message: string | null): void => {
    setState({ saving: false, saved: false, error: message });
  }, []);

  return { state, run, setError };
}

function SaveIndicator({ state }: { state: AutoSaveState }): ReactElement | null {
  if (state.saving) {
    return <span className="text-xs text-muted-foreground shrink-0">Saving…</span>;
  }
  if (state.saved) {
    return <span className="text-xs text-success-700 shrink-0">Saved</span>;
  }
  if (state.error) {
    return <span className="text-xs text-error-600 shrink-0">{state.error}</span>;
  }
  return null;
}

export function StatusChipEditor({
  apiFetch,
  campaign,
  onCampaignChange,
}: FieldEditorProps): ReactElement {
  const { state, run } = useAutoSave();

  const handleChange = (next: CampaignStatus): void => {
    if (next === campaign.status) return;
    void run(async () => {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, { status: next });
      onCampaignChange(updated);
    });
  };

  return (
    <div className="inline-flex items-center gap-2">
      <span
        className={`relative inline-flex items-center gap-1 status-pill status-${campaign.status} cursor-pointer hover:opacity-80 focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-1 ${
          state.saving ? 'opacity-60' : ''
        }`}
      >
        <span>{campaign.status}</span>
        <ChevronDownIcon />
        <select
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          value={campaign.status}
          onChange={(e) => handleChange(e.target.value as CampaignStatus)}
          disabled={state.saving}
          aria-label="Change campaign status"
        >
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="monitoring">monitoring</option>
          <option value="completed">completed</option>
        </select>
      </span>
      <SaveIndicator state={state} />
    </div>
  );
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-3 h-3 opacity-60"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function DateRangeField({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [start, setStart] = useState(campaign.startDate ?? '');
  const [end, setEnd] = useState(campaign.endDate ?? '');
  const { state, run, setError } = useAutoSave();

  useEffect(() => {
    setStart(campaign.startDate ?? '');
    setEnd(campaign.endDate ?? '');
  }, [campaign.startDate, campaign.endDate]);

  const commit = (nextStart: string, nextEnd: string): void => {
    const sameStart = nextStart === (campaign.startDate ?? '');
    const sameEnd = nextEnd === (campaign.endDate ?? '');
    if (sameStart && sameEnd) return;
    if (nextStart && nextEnd && nextEnd < nextStart) {
      setError('End date must be on or after start date.');
      return;
    }
    const payload: { startDate?: string; endDate?: string } = {};
    if (nextStart) payload.startDate = nextStart;
    if (nextEnd) payload.endDate = nextEnd;
    void run(async () => {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, payload);
      onCampaignChange(updated);
    });
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-2">
        <input
          type="date"
          className="input py-1.5 text-sm w-auto"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          onBlur={() => commit(start, end)}
          disabled={state.saving}
          aria-label="Start date"
        />
        <span className="text-muted-foreground">→</span>
        <input
          type="date"
          className="input py-1.5 text-sm w-auto"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          onBlur={() => commit(start, end)}
          disabled={state.saving}
          aria-label="End date"
        />
      </div>
      <SaveIndicator state={state} />
    </div>
  );
}

export function PayoutField({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [amount, setAmount] = useState(
    campaign.payout?.amount !== undefined ? String(campaign.payout.amount) : '',
  );
  const [currency, setCurrency] = useState(campaign.payout?.currency ?? 'USD');
  const paid = campaign.payout?.paid ?? false;
  const { state, run, setError } = useAutoSave();

  useEffect(() => {
    setAmount(campaign.payout?.amount !== undefined ? String(campaign.payout.amount) : '');
    setCurrency(campaign.payout?.currency ?? 'USD');
  }, [campaign.payout?.amount, campaign.payout?.currency]);

  const commit = (nextAmount: string, nextCurrency: string, nextPaid: boolean): void => {
    const trimmedAmount = nextAmount.trim();
    const trimmedCurrency = nextCurrency.toUpperCase().trim();
    const same =
      trimmedAmount === (campaign.payout?.amount !== undefined ? String(campaign.payout.amount) : '') &&
      trimmedCurrency === (campaign.payout?.currency ?? 'USD') &&
      nextPaid === paid;
    if (same) return;
    if (trimmedAmount.length === 0) {
      // No amount yet — don't save partial payout. Silent: it's just empty.
      return;
    }
    const num = Number(trimmedAmount);
    if (!Number.isFinite(num) || num < 0) {
      setError('Amount must be a non-negative number.');
      return;
    }
    if (!/^[A-Z]{3}$/.test(trimmedCurrency)) {
      setError('Currency must be a 3-letter ISO 4217 code (e.g., USD).');
      return;
    }
    void run(async () => {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, {
        payout: { amount: num, currency: trimmedCurrency, paid: nextPaid },
      });
      onCampaignChange(updated);
    });
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          step="0.01"
          className="input py-1.5 text-sm w-32"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => commit(amount, currency, paid)}
          placeholder="Amount"
          disabled={state.saving}
          aria-label="Payout amount"
        />
        <input
          type="text"
          maxLength={3}
          className="input py-1.5 text-sm uppercase w-20"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          onBlur={() => commit(amount, currency, paid)}
          placeholder="USD"
          disabled={state.saving}
          aria-label="Payout currency"
        />
        <label className="inline-flex items-center gap-2 text-sm select-none">
          <input
            type="checkbox"
            className="rounded border-border text-primary-600 focus:ring-primary-500"
            checked={paid}
            onChange={(e) => commit(amount, currency, e.target.checked)}
            disabled={state.saving}
          />
          Paid
        </label>
      </div>
      <SaveIndicator state={state} />
    </div>
  );
}

// The campaign's primary deliverable. A blog/YouTube toggle picks the type
// (PATCH deliverable_type); the URL input below it edits whichever URL the
// chosen type uses (blog_url or youtube_url). The two URLs are stored
// independently so flipping the type back and forth doesn't lose either one.
export function DeliverableField({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const deliverableType: DeliverableType = campaign.deliverable_type ?? 'blog';
  const isYoutube = deliverableType === 'youtube';
  const currentUrl = isYoutube ? campaign.youtube_url ?? '' : campaign.blog_url ?? '';

  const [value, setValue] = useState(currentUrl);
  const { state, run, setError } = useAutoSave();

  useEffect(() => {
    setValue(currentUrl);
  }, [currentUrl]);

  const switchType = (next: DeliverableType): void => {
    if (next === deliverableType) return;
    void run(async () => {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, {
        deliverable_type: next,
      });
      onCampaignChange(updated);
    });
  };

  const commit = (): void => {
    const trimmed = value.trim();
    if (trimmed === currentUrl) return;
    if (trimmed.length === 0) {
      // Don't fire an update; clearing isn't supported by the API.
      setValue(currentUrl);
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      setError('URL must start with http:// or https://');
      return;
    }
    void run(async () => {
      const payload = isYoutube ? { youtube_url: trimmed } : { blog_url: trimmed };
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, payload);
      onCampaignChange(updated);
    });
  };

  return (
    <div className="space-y-2">
      <div
        className="inline-flex rounded-md border border-border overflow-hidden text-sm"
        role="group"
        aria-label="Deliverable type"
      >
        <DeliverableTypeButton
          label="Blog"
          active={!isYoutube}
          disabled={state.saving}
          onClick={() => switchType('blog')}
        />
        <DeliverableTypeButton
          label="YouTube"
          active={isYoutube}
          disabled={state.saving}
          onClick={() => switchType('youtube')}
        />
      </div>
      <div className="flex items-center gap-3">
        <input
          type="url"
          className="input py-1.5 text-sm flex-1 min-w-0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setValue(currentUrl);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          placeholder={
            isYoutube ? 'https://www.youtube.com/watch?v=...' : 'https://blog.example.com/my-post'
          }
          disabled={state.saving}
        />
        <SaveIndicator state={state} />
      </div>
      <p className="text-xs text-muted-foreground">
        {isYoutube
          ? 'The campaign’s YouTube video. Pulls views, likes, and comments from the YouTube Data API.'
          : 'The campaign’s published blog post. Pulls GA4 traffic and Core Web Vitals.'}
      </p>
    </div>
  );
}

function DeliverableTypeButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`px-3 py-1.5 font-medium transition-colors disabled:opacity-60 ${
        active
          ? 'bg-primary-600 text-white'
          : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
      }`}
    >
      {label}
    </button>
  );
}

export function LinkTrackingIdField({
  apiFetch,
  campaign,
  onCampaignChange,
}: FieldEditorProps): ReactElement {
  const [value, setValue] = useState(campaign.link_tracking_id ?? '');
  const { state, run } = useAutoSave();

  useEffect(() => {
    setValue(campaign.link_tracking_id ?? '');
  }, [campaign.link_tracking_id]);

  const commit = (): void => {
    const trimmed = value.trim();
    if (trimmed === (campaign.link_tracking_id ?? '')) return;
    if (trimmed.length === 0) {
      // Clearing isn't supported by the API; revert.
      setValue(campaign.link_tracking_id ?? '');
      return;
    }
    void run(async () => {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, {
        link_tracking_id: trimmed,
      });
      onCampaignChange(updated);
    });
  };

  return (
    <div className="flex items-center gap-3">
      <input
        type="text"
        className="input py-1.5 text-sm font-mono w-64 max-w-full"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setValue(campaign.link_tracking_id ?? '');
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder="acme-q2-launch"
        disabled={state.saving}
      />
      <SaveIndicator state={state} />
    </div>
  );
}

function EditIconButton({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:text-primary-600 hover:bg-muted transition-colors disabled:opacity-50"
    >
      <PencilIcon />
    </button>
  );
}

function PencilIcon({ className = 'w-3.5 h-3.5' }: { className?: string }): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.379-8.379-2.828-2.828z" />
    </svg>
  );
}

export function FieldGroup({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactElement;
}): ReactElement {
  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</p>
      <div className="text-sm text-foreground">{children}</div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

