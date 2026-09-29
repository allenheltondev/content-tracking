import type { ReactElement } from 'react';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type ApiFetch } from '../auth/useApiFetch';
import { generateCampaignReport, listCampaignReports } from '../api/campaigns';
import type { CampaignReportListItem, CampaignReportResponse } from '../api/types';
import ReportLinkDialog from './ReportLinkDialog';
import { formatDate } from '../lib/format';

// History of generated reports for a campaign. Each row is a frozen snapshot
// with the date it was taken and the date its share link expires. The sponsor
// link at the top is permanent and always opens the newest snapshot, so
// generating a new report refreshes what the sponsor sees without a new link.
export default function CampaignReportsTab({
  apiFetch,
  campaignId,
}: {
  apiFetch: ApiFetch;
  campaignId: string;
}): ReactElement {
  const queryClient = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [justGenerated, setJustGenerated] = useState<CampaignReportResponse | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const reportsQuery = useQuery({
    queryKey: ['campaign', campaignId, 'reports'],
    queryFn: () => listCampaignReports(apiFetch, campaignId),
  });
  const reports = reportsQuery.data?.reports ?? null;
  const latestUrl = reportsQuery.data?.latest_url ?? null;
  const loadError = reportsQuery.error ? (reportsQuery.error as Error).message : null;

  const handleGenerate = async (): Promise<void> => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await generateCampaignReport(apiFetch, campaignId);
      setJustGenerated(result);
      // Re-fetch so the history shows the authoritative server-stamped row.
      await queryClient.invalidateQueries({ queryKey: ['campaign', campaignId, 'reports'] });
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const copyText = (text: string, id: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
    });
  };
  const copy = (item: CampaignReportListItem): void => copyText(item.url, item.reportId);

  // After generating, offer the permanent sponsor link when there is one.
  // Falls back to the snapshot's own signed link.
  const dialogReport = justGenerated && {
    url: justGenerated.latestUrl ?? justGenerated.url,
    expiresAt: justGenerated.latestUrl ? null : justGenerated.expiresAt,
    dataAsOf: justGenerated.dataAsOf,
  };

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">Reports</h2>
          <p className="text-sm text-muted-foreground">
            Each report is a snapshot frozen when you generate it. Share the sponsor link once
            and it always opens the newest report. Links to a specific snapshot stay live for 90
            days.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary shrink-0"
          disabled={generating}
          onClick={() => void handleGenerate()}
        >
          {generating ? 'Generating…' : 'Generate report'}
        </button>
      </div>

      {latestUrl && (
        <div className="rounded-lg border border-border px-4 py-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-foreground">Sponsor link</p>
              <p className="text-xs text-muted-foreground">
                Always opens the newest report. Does not expire.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <a href={latestUrl} target="_blank" rel="noreferrer" className="btn-link">
                Open
              </a>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => copyText(latestUrl, 'latest')}
              >
                {copiedId === 'latest' ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </div>
          <code className="block bg-muted rounded px-3 py-2 font-mono text-xs break-all">
            {latestUrl}
          </code>
        </div>
      )}

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
        <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Snapshot taken</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {reports.map((r, i) => (
              <tr key={r.reportId}>
                <td>
                  {formatDateTime(r.generatedAt)}
                  {i === 0 ? (
                    <span className="ml-2 text-xs font-medium text-primary-600">Latest</span>
                  ) : (
                    r.superseded && (
                      <span className="ml-2 text-xs text-muted-foreground">Superseded</span>
                    )
                  )}
                </td>
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
        </div>
      )}

      <ReportLinkDialog
        report={dialogReport}
        onClose={() => setJustGenerated(null)}
        caption={
          justGenerated && (
            <>
              {justGenerated.latestUrl
                ? 'Share this sponsor link. It opens the newest performance report with no login required, currently showing data as of '
                : 'Share this link. It opens an interactive performance report with no login required, frozen to the data as of '}
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
