import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import {
  deleteVendor,
  getVendor,
  listCampaignsForVendor,
} from '../api/vendors';
import { createCampaign } from '../api/campaigns';
import { getRevenue } from '../api/revenue';
import type {
  CreateCampaignRequest,
  RevenueResponse,
  Vendor,
  VendorCampaignSummary,
} from '../api/types';
import DeleteVendorModal from '../components/DeleteVendorModal';
import Modal from '../components/Modal';
import CreateCampaignForm from '../components/CreateCampaignForm';

const WIDE_START = '1900-01-01';
const WIDE_END = '2999-12-31';

export default function VendorDetail(): ReactElement {
  const { vendorId } = useParams<{ vendorId: string }>();
  const apiFetch = useApiFetch();
  const navigate = useNavigate();

  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [campaigns, setCampaigns] = useState<VendorCampaignSummary[] | null>(null);
  const [revenue, setRevenue] = useState<RevenueResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  const [revenueError, setRevenueError] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteServerError, setDeleteServerError] = useState<string | null>(null);
  const [blockingCount, setBlockingCount] = useState<number | null>(null);

  const [createCampaignOpen, setCreateCampaignOpen] = useState(false);
  const [createCampaignBusy, setCreateCampaignBusy] = useState(false);
  const [createCampaignError, setCreateCampaignError] = useState<string | null>(null);

  useEffect(() => {
    if (!vendorId) return;
    let cancelled = false;
    setLoadError(null);
    setCampaignsError(null);
    setRevenueError(null);

    getVendor(apiFetch, vendorId)
      .then((res) => {
        if (!cancelled) setVendor(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });

    listCampaignsForVendor(apiFetch, vendorId)
      .then((res) => {
        if (!cancelled) setCampaigns(res.campaigns);
      })
      .catch((err: Error) => {
        if (!cancelled) setCampaignsError(err.message);
      });

    getRevenue(apiFetch, { vendorId, startDate: WIDE_START, endDate: WIDE_END })
      .then((res) => {
        if (!cancelled) setRevenue(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setRevenueError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [apiFetch, vendorId]);

  const handleCreateCampaign = async (payload: CreateCampaignRequest): Promise<void> => {
    setCreateCampaignBusy(true);
    setCreateCampaignError(null);
    try {
      const created = await createCampaign(apiFetch, payload);
      navigate(`/campaigns/${created.campaign_id}`);
    } catch (err) {
      setCreateCampaignError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setCreateCampaignBusy(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!vendorId) return;
    setDeleteBusy(true);
    setDeleteServerError(null);
    setBlockingCount(null);
    try {
      await deleteVendor(apiFetch, vendorId);
      navigate('/vendors');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const count = extractCampaignCount(err);
        setBlockingCount(count ?? 1);
      } else {
        setDeleteServerError(err instanceof ApiError ? err.message : (err as Error).message);
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  if (loadError) {
    return (
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">Vendor not found</h1>
        <p className="form-error">{loadError}</p>
        <Link to="/vendors" className="btn-link">
          Back to vendors
        </Link>
      </section>
    );
  }

  if (!vendor) {
    return (
      <section>
        <h1 className="text-2xl font-semibold">Vendor</h1>
        <p className="text-muted-foreground">Loading...</p>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">{vendor.name}</h1>
          {vendor.contact_email && (
            <p className="text-muted-foreground">{vendor.contact_email}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/vendors/${vendor.vendor_id}/edit`} className="btn-secondary">
            Edit
          </Link>
          <button
            type="button"
            className="btn-destructive"
            onClick={() => {
              setBlockingCount(null);
              setDeleteServerError(null);
              setDeleteOpen(true);
            }}
          >
            Delete
          </button>
        </div>
      </header>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
        {vendor.website && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Website</dt>
            <dd className="text-sm mt-0.5">
              <a
                href={vendor.website}
                target="_blank"
                rel="noreferrer"
                className="text-primary-600 hover:underline"
              >
                {vendor.website}
              </a>
            </dd>
          </div>
        )}
        {vendor.contact_name && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Contact</dt>
            <dd className="text-sm text-foreground mt-0.5">{vendor.contact_name}</dd>
          </div>
        )}
        {vendor.payment_terms && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Payment terms</dt>
            <dd className="text-sm text-foreground mt-0.5">{vendor.payment_terms}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Added</dt>
          <dd className="text-sm text-foreground mt-0.5">{vendor.created_at.slice(0, 10)}</dd>
        </div>
      </dl>

      {vendor.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {vendor.tags.map((t) => (
            <span className="tag-chip" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}

      {vendor.notes && (
        <section className="card card-body">
          <h2 className="text-sm font-semibold text-foreground mb-1">Notes</h2>
          <p className="text-sm text-foreground whitespace-pre-wrap">{vendor.notes}</p>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Revenue</h2>
        {revenueError && (
          <p className="form-error">Could not load revenue: {revenueError}</p>
        )}
        {!revenue && !revenueError && (
          <p className="text-muted-foreground">Loading revenue...</p>
        )}
        {revenue && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <RevenueTile
              label="Total earned"
              value={formatMoney(revenue.total.amount, revenue.currency)}
            />
            <RevenueTile
              label="Received"
              value={formatMoney(revenue.received.amount, revenue.currency)}
            />
            <RevenueTile label="Campaigns counted" value={String(revenue.total.campaignCount)} />
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-foreground">Campaigns</h2>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setCreateCampaignError(null);
              setCreateCampaignOpen(true);
            }}
          >
            Add campaign
          </button>
        </div>
        {campaignsError && (
          <p className="form-error">Could not load campaigns: {campaignsError}</p>
        )}
        {!campaigns && !campaignsError && (
          <p className="text-muted-foreground">Loading campaigns...</p>
        )}
        {campaigns && campaigns.length === 0 && (
          <p className="text-muted-foreground">No campaigns yet for this vendor.</p>
        )}
        {campaigns && campaigns.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Dates</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.campaign_id}>
                  <td>
                    <Link
                      to={`/campaigns/${c.campaign_id}`}
                      className="text-primary-600 hover:underline"
                    >
                      {c.name}
                    </Link>
                  </td>
                  <td>
                    <span className={`status-pill status-${c.status}`}>{c.status}</span>
                  </td>
                  <td className="text-muted-foreground">
                    {formatDateRange(c.startDate, c.endDate)}
                  </td>
                  <td className="text-muted-foreground">{c.created_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal
        open={createCampaignOpen}
        title="Add campaign"
        onClose={() => {
          if (!createCampaignBusy) {
            setCreateCampaignOpen(false);
            setCreateCampaignError(null);
          }
        }}
      >
        <CreateCampaignForm
          busy={createCampaignBusy}
          serverError={createCampaignError}
          lockedVendorId={vendor.vendor_id}
          onSubmit={(p) => void handleCreateCampaign(p)}
          onCancel={() => {
            setCreateCampaignOpen(false);
            setCreateCampaignError(null);
          }}
        />
      </Modal>

      <DeleteVendorModal
        open={deleteOpen}
        vendorName={vendor.name}
        busy={deleteBusy}
        serverError={deleteServerError}
        blockingCampaignCount={blockingCount}
        onConfirm={() => void handleDelete()}
        onClose={() => {
          if (!deleteBusy) {
            setDeleteOpen(false);
            setBlockingCount(null);
            setDeleteServerError(null);
          }
        }}
      />
    </section>
  );
}

function RevenueTile({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="card card-body !py-3">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground mt-1 block">{value}</span>
    </div>
  );
}

// Pull the linked-campaign count out of a 409 body. The API formats the
// error message like "Vendor X has N linked campaigns; delete those
// first" — adjust if the backend wording changes.
function extractCampaignCount(err: ApiError): number | null {
  const message = typeof err.message === 'string' ? err.message : '';
  const match = message.match(/(\d+)\s+linked campaign/i);
  return match ? Number(match[1]) : null;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate && !endDate) return '-';
  if (startDate && endDate) return `${startDate} → ${endDate}`;
  return startDate ?? endDate ?? '-';
}
