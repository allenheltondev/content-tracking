import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import Modal from './Modal';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Written into ui/dist/ by scripts/build-extension-zip.mjs as part of the
// deploy workflow (after the vite build, before s3 sync), so the file
// ships at the dashboard origin's root in staging and production. In
// local `npm run dev` the URL 404s; run `npm run build-extension-zip`
// from repo root + `npm run preview` to exercise the download path.
const EXTENSION_ZIP_URL = '/booked-extension.zip';

export default function InstallExtensionModal({ open, onClose }: Props): ReactElement {
  return (
    <Modal open={open} title="Install the Booked Chrome extension" onClose={onClose}>
      <div className="space-y-4 text-sm text-foreground">
        <p>
          The extension reads engagement numbers off X, LinkedIn, and Instagram as you browse
          your tracked social posts. It writes those numbers back to Booked so the{' '}
          <span className="font-medium">Last fetched</span> column stays current.
        </p>

        <div>
          <a
            href={EXTENSION_ZIP_URL}
            download="booked-extension.zip"
            className="btn-primary inline-flex"
          >
            Download extension (.zip)
          </a>
        </div>

        <ol className="list-decimal list-inside space-y-2">
          <li>Unzip the download anywhere on your machine.</li>
          <li>
            Open{' '}
            <code className="bg-muted rounded px-1.5 py-0.5 text-xs font-mono">
              chrome://extensions
            </code>{' '}
            in Chrome and turn on Developer mode (top right).
          </li>
          <li>
            Click <span className="font-medium">Load unpacked</span> and select the{' '}
            <code className="font-mono text-xs">booked-extension</code> folder you just
            unzipped.
          </li>
          <li>
            Open{' '}
            <Link
              to="/settings?tab=extension"
              className="text-primary-600 hover:underline"
              onClick={onClose}
            >
              Settings → Extension
            </Link>{' '}
            and click <span className="font-medium">+</span> next to{' '}
            <span className="font-medium">Paired devices</span> to generate a code. Copy it
            from the dialog.
          </li>
          <li>
            Open the extension popup, paste the code into the{' '}
            <span className="font-medium">Pairing code</span> field, and click{' '}
            <span className="font-medium">Pair extension</span>. Your tracked posts show up
            in the popup once the pairing finishes.
          </li>
        </ol>

        <p className="text-muted-foreground">
          The pairing code grants the extension access to your Booked account. Revoke it any
          time from the same Settings page.
        </p>

        <div className="flex justify-end pt-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
