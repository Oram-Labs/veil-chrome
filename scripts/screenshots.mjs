// Screenshots of the popup and the blocked-message banner, for the docs.
// Uses the built files with stand-in answers from Veil, so the app need not
// run. From extension/: `pnpm build && node scripts/screenshots.mjs`.
// Writes ../docs/screenshots/extension-*.png.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const out = (name) => `../docs/screenshots/extension-${name}.png`;
const popup = pathToFileURL(resolve('dist/unpacked/popup.html')).href;
const bridge = readFileSync('dist/unpacked/bridge.js', 'utf8');
const ok = {
  ok: true,
  result: { version: '0.1.10', running: true, activated: true, mode: 'redact', fail_closed: true, sites: { 'claude.ai': true, 'chatgpt.com': true } },
};
const states = {
  protecting: { status: ok, count: 7, url: 'https://claude.ai/chat/x' },
  'not-running': { status: { ok: false, error: 'not_running' }, count: 2, url: 'https://chatgpt.com/' },
  paused: { status: { ...ok, result: { ...ok.result, running: false } }, count: 0, url: 'https://chatgpt.com/' },
};

const browser = await chromium.launch();
for (const scheme of ['light', 'dark']) {
  for (const [name, s] of Object.entries(states)) {
    const page = await browser.newPage({ viewport: { width: 320, height: 300 }, deviceScaleFactor: 2, colorScheme: scheme });
    await page.addInitScript((s) => {
      window.chrome = {
        tabs: { query: async () => [{ id: 1, url: s.url }] },
        runtime: { sendMessage: async (m) => (m.op === 'status' ? s.status : s.count) },
        storage: { local: { get: async () => ({}), set: async () => {} } },
      };
    }, s);
    await page.goto(popup);
    await page.waitForFunction(() => document.getElementById('summary').textContent !== 'Checking…');
    await page.setViewportSize({ width: 320, height: await page.evaluate(() => document.body.scrollHeight) });
    await page.screenshot({ path: out(`popup-${name}-${scheme}`) });
    await page.close();
  }

  const dark = scheme === 'dark';
  const page = await browser.newPage({ viewport: { width: 760, height: 200 }, deviceScaleFactor: 2, colorScheme: scheme });
  await page.setContent(`<body style="margin:0;height:100vh;background:${dark ? '#212121' : '#fff'};color:${dark ? '#ececec' : '#333'};font:15px system-ui">
    <div style="position:absolute;bottom:24px;left:24px;right:24px;border:1px solid #8884;border-radius:24px;padding:14px 18px">write to ana.popescu@example.com…</div></body>`);
  await page.evaluate((src) => {
    window.chrome = { runtime: { sendMessage: async () => ({}) }, storage: { local: { get: async () => ({}) } } };
    new Function(src)();
    const { port1, port2 } = new MessageChannel();
    window.postMessage({ __veil: 'hello' }, '*', [port2]);
    setTimeout(() => port1.postMessage({ id: 0, kind: 'blocked', message: "Veil isn't running, so this message was not sent. Open Veil and try again." }), 50);
  }, bridge);
  await page.waitForSelector('veil-banner', { state: 'attached' });
  await page.waitForTimeout(100);
  await page.screenshot({ path: out(`banner-${scheme}`) });
  await page.close();
}
await browser.close();
