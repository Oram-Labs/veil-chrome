// Builds the extension into dist/unpacked for "Load unpacked", and with --zip
// also makes dist/veil-extension-<version>.zip, which publish.sh chrome puts
// on the site (and which the Chrome Web Store takes as it is). The zip is
// reproducible: `pnpm verify <zip>` checks one against this source.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundle } from './scripts/bundle.mjs';
import { writeZip } from './scripts/zip.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
await bundle(root, `${root}dist/unpacked`);

if (process.argv.includes('--zip')) {
  const { version } = JSON.parse(readFileSync(`${root}static/manifest.json`, 'utf8'));
  const zip = `dist/veil-extension-${version}.zip`;
  writeZip(`${root}dist/unpacked`, `${root}${zip}`);
  const sha = createHash('sha256').update(readFileSync(`${root}${zip}`)).digest('hex');
  console.log(`${zip}\nsha256 ${sha}`);
}
