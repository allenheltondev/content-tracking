import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type ApiFetch } from '../auth/useApiFetch';
import { generateCampaignReport, listCampaignReports } from '../api/campaigns';
import type { CampaignReportListItem, CampaignReportResponse } from '../api/types';
import ReportLinkDialog from './ReportLinkDialog';

// History of generated reports for a campaign. Each row is a frozen snapshot
// with the date it was taken and the date its share link expires. Generating
// a new one captures a fresh snapshot and opens its share link.
export default function CampaignReportsTab({
  apiFetch,
  campaignId,
}: {
  apiFetch: ApiFetch;
  campaignId: string;
}): ReactElement {
  const [reports, setReports] = useState<CampaignReportListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [justGenerated, setJustGenerated] = useState<CampaignReportResponse | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadReports = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const res = await listCampaignReports(apiFetch, campaignId);
      setReports(res.reports);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }, [apiFetch, campaignId]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const handleGenerate = async (): Promise<void> => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await generateCampaignReport(apiFetch, campaignId);
      setJustGenerated(result);
      // Re-fetch so the history shows the authoritative server-stamped row.
      await loadReports();
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const copy = (item: CampaignReportListItem): void => {
    void navigator.clipboard.writeText(item.url).then(() => {
      setCopiedId(item.reportId);
      setTimeout(() => setCopiedId((id) => (id === item.reportId ? null : id)), 1500);
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">Reports</h2>
          <p className="text-sm text-muted-foreground">
            Each report is a snapshot frozen when you generate it. Share links stay live for 90
            days.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary shrink-0"
          disabled={generating}
          onClick={() => void handleGenerate()}
        >
          {generating ? 'Generating…' : 'Generate report'}
        </button>
      </div>

      {generateError && <p className="form-error">Could not generate report: {generateError}</p>}
      {loadError && <p className="form-error">Could not load reports: {loadError}</p>}

      {reports === null && !loadError && (
        <p className="text-muted-foreground">Loading reports...</p>
      )}

      {reports !== null && reports.length === 0 && (
        <p className="text-muted-foreground">
          No reports yet. Generate one to capture a snapshot of this campaign.
        </p>
      )}

      {reports !== null && reports.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Snapshot taken</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.reportId}>
                <td>{formatDateTime(r.generatedAt)}</td>
                <td className="text-muted-foreground">{formatDate(r.expiresAt)}</td>
                <td>
                  <div className="flex items-center justify-end gap-3">
                    <a href={r.url} target="_blank" rel="noreferrer" className="btn-link">
                      Open
                    </a>
                    <button type="button" className="btn-link" onClick={() => copy(r)}>
                      {copiedId === r.reportId ? 'Copied' : 'Copy link'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ReportLinkDialog
        report={justGenerated}
        onClose={() => setJustGenerated(null)}
        caption={
          justGenerated && (
            <>
              Share this link. It opens an interactive performance report with no login required,
              frozen to the data as of{' '}
              <span className="text-foreground">{justGenerated.dataAsOf}</span>.
            </>
          )
        }
      />
    </section>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}
