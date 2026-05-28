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

await mkdir(outDir, { recursive: true });

const configPath = path.join(extensionDir, 'src', 'config.js');
const configTemplate = await readFile(configPath, 'utf8');
const configWithUrl = configTemplate.replace('__BOOKED_API_BASE_URL__', apiBaseUrl);

await new Promise((resolve, reject) => {
  const output = createWriteStream(outPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  output.on('close', () => {
    console.log(
      `[build-extension-zip] wrote ${path.relative(repoRoot, outPath)} (${archive.pointer()} bytes), apiBaseUrl=${apiBaseUrl || '(unset)'}`,
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
  // config.js is appended separately below with apiBaseUrl substituted
  // in; everything else streams in from disk via glob.
  archive.glob('**/*', {
    cwd: extensionDir,
    ignore: ['__tests__/**', 'node_modules/**', '.DS_Store', 'src/config.js'],
    dot: false,
  }, { prefix: 'booked-extension/' });
  archive.append(configWithUrl, { name: 'booked-extension/src/config.js' });
  archive.finalize();
});
