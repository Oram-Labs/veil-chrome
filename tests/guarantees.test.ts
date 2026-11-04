// What the extension promises in its README and PROTOCOL.md, checked against
// its source and manifest. Each list below is the complete, reviewed set: a
// change to what the extension can reach, store or replace fails here until
// the list (and the docs) are updated on purpose.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'static/manifest.json'), 'utf8'));

/** Every source file (TypeScript and Svelte), as `[path relative to src, text without comments]`. */
function sources(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts') || path.endsWith('.svelte')) {
        const text = readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        out.push([relative(join(root, 'src'), path), text]);
      }
    }
  };
  walk(join(root, 'src'));
  return out;
}

/** Each match of `re` in the source, as `file: match`. */
function found(re: RegExp): string[] {
  return sources().flatMap(([file, text]) => [...text.matchAll(re)].map((m) => `${file}: ${m[0]}`)).sort();
}

describe('permissions', () => {
  it('are only native messaging and storage, on claude.ai and chatgpt.com', () => {
    expect(manifest.permissions).toEqual(['nativeMessaging', 'storage']);
    expect(manifest.host_permissions).toEqual(['https://claude.ai/*', 'https://chatgpt.com/*']);
    for (const script of manifest.content_scripts) {
      expect(script.matches).toEqual(['https://claude.ai/*', 'https://chatgpt.com/*']);
    }
  });

  it('fit the Chrome Web Store, which refuses a description over 132 characters', () => {
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  it('let no web page or other extension talk to it, and load no remote code', () => {
    // The one policy allows the engine's WebAssembly, and nothing else beyond the default.
    expect(manifest.content_security_policy).toEqual({ extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" });
    expect(manifest.options_ui).toEqual({ page: 'options.html', open_in_tab: true });
    for (const key of ['externally_connectable', 'web_accessible_resources', 'optional_permissions', 'optional_host_permissions']) {
      expect(manifest[key], key).toBeUndefined();
    }
    expect(manifest.background).toEqual({ service_worker: 'background.js' });
    expect(found(/\b(importScripts|eval)\s*\(|new\s+Function\s*\(/g)).toEqual([]);
  });
});

describe('the network', () => {
  it('has one address of its own in the code: the site, for the popup\'s version file', () => {
    expect(found(/\b(https?|wss?):\/\/[^\s'"`]*/g)).toEqual(['popup/update.ts: https://getveil.tech']);
  });

  it('opens one connection of its own, the popup\'s version check; otherwise it only wraps the page\'s own', () => {
    expect(found(/\bnew\s+(WebSocket|XMLHttpRequest|EventSource)\s*\(|sendBeacon|sendNativeMessage/g)).toEqual([]);
    // Calls of `fetch`: the page's own fetch, passed on by the page hook's
    // wrappers, and the popup's GET of latest.json (without cookies).
    expect(found(/(?<![\w.])fetch\s*\(/g)).toEqual(['hook.ts: fetch(', 'observe.ts: fetch(', 'popup/update.ts: fetch(']);
    expect(found(/LATEST_URL = [^;]*/g)).toEqual(['popup/update.ts: LATEST_URL = `${SITE}/download/latest.json`']);
    expect(found(/credentials: '[a-z-]+'/g)).toEqual(["popup/update.ts: credentials: 'omit'"]);
  });

  it('talks to the Veil app only, through its native messaging host', () => {
    expect(found(/chrome\.runtime\.connectNative\([^)]*\)/g)).toEqual(['background.ts: chrome.runtime.connectNative(HOST_NAME)']);
    expect(found(/HOST_NAME\s*=\s*'[^']*'/g)).toEqual(["protocol.ts: HOST_NAME = 'com.veil.app.native'"]);
  });
});

describe('the page', () => {
  it('has only these of its objects replaced', () => {
    // fetch: requests go to Veil first. XMLHttpRequest, WebSocket and EventSource:
    // wrapped to report traffic while "Capture traffic" is on. streamController
    // (chatgpt.com): chat data built into the page goes to Veil first.
    expect(found(/(window|XHR)\.\w+\s*=(?!=)/g)).toEqual([
      'hook.ts: window.fetch =',
      'observe.ts: XHR.open =',
      'observe.ts: XHR.send =',
      'observe.ts: window.EventSource =',
      'observe.ts: window.WebSocket =',
    ]);
    expect(found(/defineProperty\((window|holder|target), '\w+'/g)).toEqual([
      "hook.ts: defineProperty(window, '__veilHooked'",
      "pagedata.ts: defineProperty(holder, 'streamController'",
      "pagedata.ts: defineProperty(target, '__reactRouterContext'",
    ]);
  });
});

describe('storage', () => {
  it('holds counts, preferences, the latest version numbers and the built-in engine\'s own data, never chat text', () => {
    expect(found(/chrome\.storage\.\w+\.(set|remove)\([^)]*\)/g)).toEqual([
      // The built-in engine's store: `store.set(key, value)` below says which keys.
      'background.ts: chrome.storage.local.remove(key)',
      'background.ts: chrome.storage.local.set({ [key]: value })',
      'background.ts: chrome.storage.session.remove(`count:${tab}`)',
      'background.ts: chrome.storage.session.set({ [key]: total })',
      // Which engine each chat used, by the chat's id, for the session.
      'background.ts: chrome.storage.session.set({ pins: all })',
      // When the settings page's card about the Veil app was hidden until.
      'options/Upsell.svelte: chrome.storage.local.set({ upsell: { hiddenUntil: Date.now()',
      'popup/popup.ts: chrome.storage.local.set({ prefs: next })',
      'popup/update.ts: chrome.storage.local.set({ latest: { at: now, data: parseLatest(data)',
    ]);
  });

  it('keeps for the built-in engine only its settings, rules, activity counts, on/off choice and pause', () => {
    expect(found(/store\.(set|remove)\(\s*[A-Z_a-z']+/g)).toEqual([
      "local/engine.ts: store.remove('paused'",
      "local/engine.ts: store.set('paused'",
      'local/engine.ts: store.set(ACTIVITY',
      'local/engine.ts: store.set(CONFIG',
      'local/engine.ts: store.set(LOCAL',
      'local/engine.ts: store.set(RULES',
    ].sort());
  });

  it('keeps the values behind placeholders only in the session storage, which Chrome holds in memory', () => {
    expect(found(/\b(localStorage|sessionStorage|indexedDB|IDBFactory|caches\.open)\b/g)).toEqual([]);
    expect(found(/new SessionMemory\([^)]*\)/g)).toEqual(['background.ts: new SessionMemory(chrome.storage.session)']);
    // Session storage isn't readable from the sites' pages (Chrome's default access level).
    expect(found(/setAccessLevel/g)).toEqual([]);
  });
});

describe('the build', () => {
  it('is not minified, so the shipped zip stays readable', () => {
    // The esbuild settings both `pnpm build` and `pnpm verify` use.
    const build = readFileSync(join(root, 'scripts/bundle.mjs'), 'utf8');
    expect(build).toMatch(/\bminify:\s*false\b/);
    expect(build).not.toMatch(/\bminify(Whitespace|Identifiers|Syntax):\s*true\b/);
  });
});

describe('the bundle', () => {
  it('holds no path of the machine it was built on, so every machine builds the same zip', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { bundle } = await import('../scripts/bundle.mjs');
    const out = mkdtempSync(join(tmpdir(), 'veil-bundle-'));
    try {
      await bundle(root, out, 'silent');
      for (const name of readdirSync(out).filter((n) => /\.(js|css|html|json)$/.test(n))) {
        const text = readFileSync(join(out, name), 'utf8');
        expect(text.includes(root), name).toBe(false);
        expect(/\/(Users|home)\/[^/\s]+\//.test(text), name).toBe(false);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
