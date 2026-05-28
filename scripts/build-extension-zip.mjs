// Packages the extension/ folder into a zip placed inside the freshly
// built dashboard at ui/dist/booked-extension.zip. The deploy workflow
// calls this after `npm run build` and before s3 sync, so every deploy
// ships a zip built from the same commit as the dashboard pointing at
// it. Locally, run `npm run build-extension-zip` from repo root if you
// need to test the download path through `vite preview`.

import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const extensionDir = path.join(repoRoot, 'extension');
const outDir = path.join(repoRoot, 'ui', 'dist');
const outPath = path.join(outDir, 'booked-extension.zip');

// CI passes the dashboard's API base URL (the same value baked into
// VITE_API_BASE_URL) so the zipped extension knows where to call
// without the user pasting a URL. Local runs without the env var still
// produce a working zip; the extension's popup flags the missing URL
// instead of silently calling the wrong host.
const apiBaseUrl = process.env.VITE_API_BASE_URL || '';
// Dashboard URL is baked in for two reasons: the popup uses it to
// deep-link the user back to Settings → Extension when they haven't
// paired yet, and the dashboard content_script's match is rewritten
// to this origin so the Refresh-stale button injects on whichever
// origin the dashboard was deployed to. Optional — a zip without it
// keeps the popup text plain and leaves the source manifest's
// default match in place.
const dashboardBaseUrl = process.env.BOOKED_DASHBOARD_URL || '';

await mkdir(outDir, { recursive: true });

const configPath = path.join(extensionDir, 'src', 'config.js');
const configTemplate = await readFile(configPath, 'utf8');
const configWithUrl = configTemplate
  .replace('__BOOKED_API_BASE_URL__', apiBaseUrl)
  .replace('__BOOKED_DASHBOARD_URL__', dashboardBaseUrl);

// Apply packaging-time rewrites to the manifest:
//   1. Append the API origin to host_permissions so the service worker
//      can call cross-origin without a runtime prompt.
//   2. Rewrite the dashboard content_script entry's match so the
//      Refresh-stale button injects on whichever origin the dashboard
//      was deployed to.
// The source manifest stays clean (prod defaults) so load-unpacked
// from extension/ still works for dev; the popup falls back to
// chrome.permissions.request for the host_permissions path.
const manifestPath = path.join(extensionDir, 'manifest.json');
const manifestText = await readFile(manifestPath, 'utf8');
const manifestForZip = rewriteManifestForZip(manifestText, {
  apiBaseUrl,
  dashboardBaseUrl,
});

await mkdir(outDir, { recursive: true });

await new Promise((resolve, reject) => {
  const output = createWriteStream(outPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  output.on('close', () => {
    console.log(
      `[build-extension-zip] wrote ${path.relative(repoRoot, outPath)} (${archive.pointer()} bytes), apiBaseUrl=${apiBaseUrl || '(unset)'}, dashboardBaseUrl=${dashboardBaseUrl || '(unset)'}`,
    );
    resolve();
  });
  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') console.warn(err);
    else reject(err);
  });
  archive.on('error', reject);

  archive.pipe(output);
  // Wrap files in a top-level booked-extension/ folder so unzipping
  // produces a predictable folder name for Chrome's Load Unpacked.
  // config.js + manifest.json are appended separately below with the
  // packaging-time substitutions applied; everything else streams in
  // from disk via glob.
  archive.glob('**/*', {
    cwd: extensionDir,
    ignore: ['__tests__/**', 'node_modules/**', '.DS_Store', 'src/config.js', 'manifest.json'],
    dot: false,
  }, { prefix: 'booked-extension/' });
  archive.append(configWithUrl, { name: 'booked-extension/src/config.js' });
  archive.append(manifestForZip, { name: 'booked-extension/manifest.json' });
  archive.finalize();
});

function rewriteManifestForZip(manifestText, { apiBaseUrl, dashboardBaseUrl }) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    console.warn('[build-extension-zip] manifest parse failed; skipping rewrites:', err);
    return manifestText;
  }
  applyApiHostPermission(manifest, apiBaseUrl);
  applyDashboardMatch(manifest, dashboardBaseUrl);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function applyApiHostPermission(manifest, baseUrl) {
  const origin = parseOrigin(baseUrl, 'VITE_API_BASE_URL');
  if (!origin) return;
  const pattern = `${origin}/*`;
  if (!manifest.host_permissions?.includes(pattern)) {
    manifest.host_permissions = [...(manifest.host_permissions ?? []), pattern];
  }
}

function applyDashboardMatch(manifest, dashUrl) {
  const origin = parseOrigin(dashUrl, 'BOOKED_DASHBOARD_URL');
  if (!origin) return;
  const entry = (manifest.content_scripts || []).find(
    (cs) => Array.isArray(cs.js) && cs.js.includes('src/content/dashboard.js'),
  );
  if (!entry) {
    console.warn('[build-extension-zip] no dashboard content_script entry found; skipping match rewrite.');
    return;
  }
  entry.matches = [`${origin}/*`];
}

function parseOrigin(url, label) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    console.warn(`[build-extension-zip] ${label}=${url} is not a valid URL; skipping.`);
    return null;
  }
}
