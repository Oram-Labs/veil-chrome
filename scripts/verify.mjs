// Checks that the extension is built from this source: builds it again and
// compares every file. Give it a release zip, or the folder Chrome installed
// the Chrome Web Store copy into:
//
//   pnpm verify ~/Downloads/veil-extension-0.2.0.zip
//   pnpm verify ~/Library/Application\ Support/Google/Chrome/Default/Extensions/lanejpecogmomcibpjcomddmkgpagneb/0.2.0_0
//
// Check out the source of the zip's version first (the version is in the
// zip's manifest.json). A Chrome Web Store copy differs only in two fields
// the Store sets in manifest.json, `key` and `update_url`; those are reported
// and not counted as differences.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './bundle.mjs';
import { filesIn } from './zip.mjs';

const zip = process.argv[2];
if (!zip || !existsSync(zip)) {
  console.error('usage: pnpm verify <zip or folder>');
  process.exit(2);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'veil-chrome-verify-'));
try {
  const built = join(work, 'built');
  const theirs = join(work, 'zip');
  await bundle(root, built, 'warning');
  if (statSync(zip).isDirectory()) {
    cpSync(zip, theirs, { recursive: true });
    console.log(`folder: ${zip}`);
  } else {
    execFileSync('unzip', ['-q', '-o', zip, '-d', theirs]);
    const sha = createHash('sha256').update(readFileSync(zip)).digest('hex');
    console.log(`zip: ${zip}\nsha256: ${sha}`);
  }
  const ours = filesIn(built);
  const zipped = filesIn(theirs).filter((f) => !f.startsWith('_metadata/'));
  const problems = [];
  const notes = [];
  for (const f of zipped.filter((f) => !ours.includes(f))) problems.push(`only in the zip: ${f}`);
  for (const f of ours.filter((f) => !zipped.includes(f))) problems.push(`missing from the zip: ${f}`);
  for (const f of ours.filter((f) => zipped.includes(f))) {
    const a = readFileSync(join(built, f));
    const b = readFileSync(join(theirs, f));
    if (a.equals(b)) continue;
    if (f === 'manifest.json') {
      const mine = JSON.parse(a.toString('utf8'));
      const store = JSON.parse(b.toString('utf8'));
      for (const key of ['key', 'update_url']) {
        if (JSON.stringify(mine[key]) !== JSON.stringify(store[key])) notes.push(`manifest.json "${key}" differs (the Chrome Web Store sets it)`);
        delete mine[key];
        delete store[key];
      }
      if (JSON.stringify(mine) === JSON.stringify(store)) continue;
    }
    problems.push(`differs: ${f}`);
  }
  if (filesIn(theirs).some((f) => f.startsWith('_metadata/'))) notes.push('_metadata/ ignored (the Chrome Web Store adds it)');
  for (const n of notes) console.log(`note: ${n}`);
  if (problems.length) {
    for (const p of problems) console.log(`MISMATCH ${p}`);
    console.log(`It is not a build of this source (${problems.length} difference${problems.length === 1 ? '' : 's'}).`);
    process.exitCode = 1;
  } else {
    let commit = '';
    try {
      commit = execFileSync('git', ['-C', root, 'describe', '--always', '--dirty'], { encoding: 'utf8' }).trim();
    } catch {
      // Not a git checkout.
    }
    console.log(`OK: all ${ours.length} files match this source${commit ? ` (${commit})` : ''}.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
