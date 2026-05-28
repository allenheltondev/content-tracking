// Packages the extension/ folder into a zip placed inside the freshly
// built dashboard at ui/dist/booked-extension.zip. The deploy workflow
// calls this after `npm run build` and before s3 sync, so every deploy
// ships a zip built from the same commit as the dashboard pointing at
// it. Locally, run `npm run build-extension-zip` from repo root if you
// need to test the download path through `vite preview`.

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const extensionDir = path.join(repoRoot, 'extension');
const outDir = path.join(repoRoot, 'ui', 'dist');
const outPath = path.join(outDir, 'booked-extension.zip');

await mkdir(outDir, { recursive: true });

await new Promise((resolve, reject) => {
  const output = createWriteStream(outPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  output.on('close', () => {
    console.log(
      `[build-extension-zip] wrote ${path.relative(repoRoot, outPath)} (${archive.pointer()} bytes)`,
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
  archive.glob('**/*', {
    cwd: extensionDir,
    ignore: ['__tests__/**', 'node_modules/**', '.DS_Store'],
    dot: false,
  }, { prefix: 'booked-extension/' });
  archive.finalize();
});
