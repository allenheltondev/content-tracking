import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import { createCampaign, listCampaigns } from '../api/campaigns';
import type { Campaign, CampaignStatus, CreateCampaignRequest } from '../api/types';
import Modal from '../components/Modal';
import CreateCampaignForm from '../components/CreateCampaignForm';

type StatusFilter = 'all' | CampaignStatus;

export default function Campaigns(): ReactElement {
  const apiFetch = useApiFetch();
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setCampaigns(null);
    listCampaigns(apiFetch, statusFilter === 'all' ? {} : { status: statusFilter })
      .then((res) => {
        if (!cancelled) setCampaigns(res.campaigns);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, statusFilter]);

  const handleCreate = async (payload: CreateCampaignRequest): Promise<void> => {
    setBusy(true);
    setServerError(null);
    try {
      const created = await createCampaign(apiFetch, payload);
      navigate(`/campaigns/${created.campaign_id}?tab=brief`);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold text-foreground">Campaigns</h1>
        <button type="button" className="btn btn-primary" onClick={() => setModalOpen(true)}>
          Create campaign
        </button>
      </header>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Status</span>
          <select
            className="input w-auto py-1.5"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="all">All</option>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="monitoring">Monitoring</option>
            <option value="completed">Completed</option>
          </select>
        </label>
      </div>

      {error && <p className="form-error">{error}</p>}
      {campaigns === null && !error && <p className="text-muted-foreground">Loading...</p>}
      {campaigns && campaigns.length === 0 && (
        <div className="card card-body text-center py-12 space-y-4">
          <p className="text-muted-foreground">No campaigns yet.</p>
          <button type="button" className="btn btn-primary" onClick={() => setModalOpen(true)}>
            Create your first campaign
          </button>
        </div>
      )}
      {campaigns && campaigns.length > 0 && (
        <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Sponsor</th>
              <th>Status</th>
              <th>Dates</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.campaign_id}>
                <td>
                  <Link to={`/campaigns/${c.campaign_id}`} className="text-primary-600 hover:underline">
                    {c.name}
                  </Link>
                </td>
                <td className="text-muted-foreground">{c.sponsor ?? '-'}</td>
                <td>
                  <span className={`status-pill status-${c.status}`}>{c.status}</span>
                </td>
                <td className="text-muted-foreground">{formatDateRange(c.startDate, c.endDate)}</td>
                <td className="text-muted-foreground">{formatCreatedAt(c.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <Modal
        open={modalOpen}
        title="Create campaign"
        onClose={() => {
          if (!busy) {
            setModalOpen(false);
            setServerError(null);
          }
        }}
      >
        <CreateCampaignForm
          busy={busy}
          serverError={serverError}
          onSubmit={(p) => void handleCreate(p)}
          onCancel={() => {
            setModalOpen(false);
            setServerError(null);
          }}
        />
      </Modal>
    </section>
  );
}

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate && !endDate) return '-';
  if (startDate && endDate) return `${startDate} → ${endDate}`;
  return startDate ?? endDate ?? '-';
}

function formatCreatedAt(iso: string): string {
  return iso.slice(0, 10);
}
