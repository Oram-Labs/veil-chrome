// What the extension promises in its README and PROTOCOL.md, checked against
// its source and manifest. Each list below is the complete, reviewed set: a
// change to what the extension can reach, store or replace fails here until
// the list (and the docs) are updated on purpose.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'static/manifest.json'), 'utf8'));

/** Every source file, as `[path relative to src, text without comments]`. */
function sources(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) {
        const text = readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
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
    for (const key of ['externally_connectable', 'web_accessible_resources', 'optional_permissions', 'optional_host_permissions', 'content_security_policy']) {
      expect(manifest[key], key).toBeUndefined();
    }
    expect(manifest.background).toEqual({ service_worker: 'background.js' });
    expect(found(/\b(importScripts|eval)\s*\(|new\s+Function\s*\(/g)).toEqual([]);
  });
});

describe('the network', () => {
  it('has no addresses of its own in the code', () => {
    expect(found(/\b(https?|wss?):\/\/[^\s'"`]*/g)).toEqual([]);
  });

  it('opens no connections of its own: it only wraps the page\'s own, to inspect them', () => {
    expect(found(/\bnew\s+(WebSocket|XMLHttpRequest|EventSource)\s*\(|sendBeacon|sendNativeMessage/g)).toEqual([]);
    // Calls of `fetch`: the page's own fetch, passed on by the page hook's wrappers.
    expect(found(/(?<![\w.])fetch\s*\(/g)).toEqual(['hook.ts: fetch(', 'observe.ts: fetch(']);
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
  it('holds counts and preferences, never text', () => {
    expect(found(/chrome\.storage\.\w+\.(set|remove)\([^)]*\)/g)).toEqual([
      'background.ts: chrome.storage.session.remove(`count:${tab}`)',
      'background.ts: chrome.storage.session.set({ [key]: total })',
      'popup/popup.ts: chrome.storage.local.set({ prefs: next })',
    ]);
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
