import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import Modal from './Modal';

// Shows the signed share link for a freshly generated report. The link is
// time-limited (CloudFront signed URL); the dialog surfaces the expiry and
// the "data as of" date so the user knows what they're sharing. Shared by
// the vendor and campaign report flows — pass a `caption` to tailor the
// intro paragraph to each context.
export default function ReportLinkDialog({
  report,
  onClose,
  caption,
}: {
  report: {
    url: string;
    shortUrl?: string | null;
    expiresAt: string;
    dataAsOf: string;
  } | null;
  onClose: () => void;
  caption?: ReactNode;
}): ReactElement | null {
  const [copied, setCopied] = useState(false);

  if (!report) return null;

  // Prefer the shortlink — it's the customer-facing URL. Fall back to the
  // signed URL when minting failed (older reports never had a shortUrl).
  const shareUrl = report.shortUrl ?? report.url;

  const copy = (): void => {
    void navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Modal open title="Report link" onClose={onClose}>
      <div className="space-y-4 text-sm text-foreground">
        <p className="text-muted-foreground">
          {caption ?? (
            <>
              Share this link. It opens an interactive report — no login
              required — and is frozen to the data as of{' '}
              <span className="text-foreground">{report.dataAsOf}</span>.
            </>
          )}
        </p>
        <div className="space-y-2">
          <code className="block bg-muted rounded p-3 font-mono text-xs break-all">
            {shareUrl}
          </code>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              Link expires {report.expiresAt.slice(0, 10)}
            </span>
            <div className="flex gap-2">
              <a href={shareUrl} target="_blank" rel="noreferrer" className="btn-link">
                Open
              </a>
              <button type="button" className="btn-secondary" onClick={copy}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </div>
        </div>
        <p className="text-muted-foreground">
          Anyone with this link can view the report until it expires. Generate a
          new report any time to refresh the data.
        </p>
        <div className="flex justify-end">
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
