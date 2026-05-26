import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import {
  deleteVendor,
  getVendor,
  listCampaignsForVendor,
} from '../api/vendors';
import { getRevenue } from '../api/revenue';
import type { RevenueResponse, Vendor, VendorCampaignSummary } from '../api/types';
import DeleteVendorModal from '../components/DeleteVendorModal';

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
      <section className="vendor-detail">
        <h1>Vendor not found</h1>
        <p className="form-error">{loadError}</p>
        <Link to="/vendors">Back to vendors</Link>
      </section>
    );
  }

  if (!vendor) {
    return (
      <section className="vendor-detail">
        <h1>Vendor</h1>
        <p>Loading...</p>
      </section>
    );
  }

  return (
    <section className="vendor-detail">
      <header className="page-header">
        <div>
          <h1>{vendor.name}</h1>
          {vendor.contact_email && <p className="page-subtitle">{vendor.contact_email}</p>}
        </div>
        <div className="header-actions">
          <Link to={`/vendors/${vendor.vendor_id}/edit`} className="secondary as-button">
            Edit
          </Link>
          <button
            type="button"
            className="danger"
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

      <dl className="metadata-grid">
        {vendor.website && (
          <div>
            <dt>Website</dt>
            <dd>
              <a href={vendor.website} target="_blank" rel="noreferrer">
                {vendor.website}
              </a>
            </dd>
          </div>
        )}
        {vendor.contact_name && (
          <div>
            <dt>Contact</dt>
            <dd>{vendor.contact_name}</dd>
          </div>
        )}
        {vendor.payment_terms && (
          <div>
            <dt>Payment terms</dt>
            <dd>{vendor.payment_terms}</dd>
          </div>
        )}
        <div>
          <dt>Added</dt>
          <dd>{vendor.created_at.slice(0, 10)}</dd>
        </div>
      </dl>

      {vendor.tags.length > 0 && (
        <div className="vendor-tags">
          {vendor.tags.map((t) => (
            <span className="tag-chip tag-chip-static" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}

      {vendor.notes && (
        <section className="vendor-notes">
          <h2>Notes</h2>
          <p>{vendor.notes}</p>
        </section>
      )}

      <section className="analytics-section">
        <h2>Revenue</h2>
        {revenueError && (
          <p className="form-error">Could not load revenue: {revenueError}</p>
        )}
        {!revenue && !revenueError && <p>Loading revenue...</p>}
        {revenue && (
          <div className="analytics-tiles">
            <div className="tile">
              <span className="tile-label">Total earned</span>
              <span className="tile-value">
                {formatMoney(revenue.total.amount, revenue.currency)}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Received</span>
              <span className="tile-value">
                {formatMoney(revenue.received.amount, revenue.currency)}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Campaigns counted</span>
              <span className="tile-value">{revenue.total.campaignCount}</span>
            </div>
          </div>
        )}
      </section>

      <section className="links-section">
        <h2>Campaigns</h2>
        {campaignsError && (
          <p className="form-error">Could not load campaigns: {campaignsError}</p>
        )}
        {!campaigns && !campaignsError && <p>Loading campaigns...</p>}
        {campaigns && campaigns.length === 0 && <p>No campaigns yet for this vendor.</p>}
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
                    <Link to={`/campaigns/${c.campaign_id}`}>{c.name}</Link>
                  </td>
                  <td>
                    <span className={`status-pill status-${c.status}`}>{c.status}</span>
                  </td>
                  <td>{formatDateRange(c.startDate, c.endDate)}</td>
                  <td>{c.created_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

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
