// Builds the extension into dist/unpacked for "Load unpacked", and with --zip
// also makes two reproducible zips, which `pnpm verify <zip>` checks against
// this source:
//   dist/veil-extension-<version>.zip        keeps "key", so a "Load unpacked"
//     copy gets the fixed ID the Veil app accepts.
//   dist/veil-extension-<version>-store.zip  the same without "key", for the
//     Chrome Web Store, which refuses a key that isn't its own.

import { createHash } from 'node:crypto';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundle } from './scripts/bundle.mjs';
import { writeZip } from './scripts/zip.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
await bundle(root, `${root}dist/unpacked`);

if (process.argv.includes('--zip')) {
  const manifest = JSON.parse(readFileSync(`${root}static/manifest.json`, 'utf8'));
  const zip = (dir, name) => {
    writeZip(`${root}${dir}`, `${root}${name}`);
    const sha = createHash('sha256').update(readFileSync(`${root}${name}`)).digest('hex');
    console.log(`${name}\nsha256 ${sha}`);
  };
  const store = 'dist/store';
  rmSync(`${root}${store}`, { recursive: true, force: true });
  cpSync(`${root}dist/unpacked`, `${root}${store}`, { recursive: true });
  delete manifest.key;
  writeFileSync(`${root}${store}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  zip(store, `dist/veil-extension-${manifest.version}-store.zip`);
  // Last, so the last line printed is this zip's SHA-256.
  zip('dist/unpacked', `dist/veil-extension-${manifest.version}.zip`);
}
