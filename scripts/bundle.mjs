// Bundles the extension into a folder: what "Load unpacked" loads and what the
// zip holds. Shared by build.mjs and verify.mjs, so a check builds exactly
// what a release does.
//
// Content scripts can't load modules, so each entry is bundled on its own.

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import sveltePlugin from 'esbuild-svelte';

/**
 * The folder of the `veil-engine` package (the engine as WebAssembly). Tests
 * that need a build accepting the test license point VEIL_ENGINE_DIR at the
 * package built with `--dev-license`; a release always uses the installed one.
 */
function enginePackage(root) {
  if (process.env.VEIL_ENGINE_DIR) return process.env.VEIL_ENGINE_DIR;
  return dirname(createRequire(join(root, 'package.json')).resolve('veil-engine/package.json'));
}

export async function bundle(root, out, logLevel = 'info') {
  const engine = enginePackage(root);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: {
      hook: 'src/hook.ts',
      bridge: 'src/bridge.ts',
      background: 'src/background.ts',
      popup: 'src/popup/popup.ts',
      options: 'src/options/main.ts',
    },
    outdir: out,
    bundle: true,
    format: 'iife',
    target: 'chrome111',
    // Not minified: anyone can read what the extension does in the zip itself.
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    // The screens shared with the Veil app (veil-ui) are Svelte components.
    // Their styles go inside the JavaScript: as separate CSS, the plugin marks
    // each with the absolute path of the build machine, which would put that
    // path in the zip and make it differ from machine to machine.
    plugins: [sveltePlugin({ compilerOptions: { css: 'injected' } })],
    conditions: ['svelte', 'browser'],
    mainFields: ['svelte', 'browser', 'module', 'main'],
    alias: { 'veil-engine': engine },
    logLevel,
  });
  cpSync(join(root, 'static'), out, { recursive: true });
  cpSync(join(engine, 'veil_engine_wasm_bg.wasm'), join(out, 'veil_engine_wasm_bg.wasm'));
}
