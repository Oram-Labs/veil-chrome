// Bundles the extension into a folder: what "Load unpacked" loads and what the
// zip holds. Shared by build.mjs and verify.mjs, so a check builds exactly
// what a release does.
//
// Content scripts can't load modules, so each entry is bundled on its own.

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

export async function bundle(root, out, logLevel = 'info') {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: {
      hook: 'src/hook.ts',
      bridge: 'src/bridge.ts',
      background: 'src/background.ts',
      popup: 'src/popup/popup.ts',
    },
    outdir: out,
    bundle: true,
    format: 'iife',
    target: 'chrome111',
    // Not minified: anyone can read what the extension does in the zip itself.
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel,
  });
  cpSync(join(root, 'static'), out, { recursive: true });
}
