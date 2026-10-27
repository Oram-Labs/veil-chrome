// End to end without the Veil app: Chromium with the built extension, and
// e2e/mock-host.mjs as the native host, in front of local stand-ins for
// claude.ai and chatgpt.com. Checks what the extension itself promises:
// what it intercepts, that text goes only to the host, and that it blocks
// sends when Veil can't be reached.
//
// Build first: `pnpm build`.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { CHAT_ID, selfSignedCert, startSites, type Received } from './sites';

const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, '../dist/unpacked');
const EXTENSION_ID = 'kgkmpkkhpegbhjloakfcibgfgpmfdjil';
const EMAIL = 'ana.popescu@example.com';
const PHONE = '+40 721 234 567';

let work: string;
let hostDir: string;
let context: BrowserContext;
let received: Received[];
let stopSites: () => void;

/** What the host was sent, in order. */
function hostLog(): { op: string; payload: { path?: string } | null }[] {
  const log = join(hostDir, 'log.jsonl');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** Turns "send without protection" on or off for a site, as the popup does. */
async function setUnprotected(site: string, on: boolean): Promise<void> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await popup.evaluate(
    ([s, v]) => chrome.storage.local.set({ prefs: { unprotected: { [s as string]: v } } }),
    [site, on] as const,
  );
  await popup.close();
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill('#box', text);
  await page.click('#send');
}

test.beforeAll(async () => {
  test.skip(!existsSync(join(extension, 'manifest.json')), 'run `pnpm build` first');
  work = mkdtempSync(join(tmpdir(), 'veil-chrome-e2e-'));
  hostDir = join(work, 'host');
  mkdirSync(hostDir);

  // The host Chrome starts: the stand-in, with its state in this test's folder.
  const host = join(work, 'mock-host.sh');
  writeFileSync(
    host,
    `#!/bin/sh\nexport MOCK_HOST_DIR='${hostDir}'\nexec '${process.execPath}' '${join(here, 'mock-host.mjs')}' "$@"\n`,
  );
  chmodSync(host, 0o755);
  const profile = join(work, 'profile');
  mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
  writeFileSync(
    join(profile, 'NativeMessagingHosts/com.veil.app.native.json'),
    JSON.stringify({ name: 'com.veil.app.native', description: 'Veil (stand-in)', path: host, type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }),
  );

  const sites = await startSites(selfSignedCert(work));
  received = sites.received;
  stopSites = () => sites.server.close();
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP claude.ai 127.0.0.1:${sites.port}, MAP chatgpt.com 127.0.0.1:${sites.port}`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });
});

test.afterAll(async () => {
  await context?.close();
  stopSites?.();
  if (work) rmSync(work, { recursive: true, force: true });
});

for (const site of ['chatgpt.com', 'claude.ai']) {
  test(`${site}: the site gets placeholders and the page shows real values`, async () => {
    const page = await context.newPage();
    await page.goto(`https://${site}/`);
    const before = received.length;
    await send(page, `Call me at ${PHONE} or write to ${EMAIL}`);
    await expect(page.locator('#status')).toHaveText('status 200 done', { timeout: 15_000 });

    const sent = received.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).not.toContain(EMAIL);
    expect(sent[0].body).not.toContain('721 234 567');
    expect(sent[0].body).toContain('[EMAIL_1]');
    expect(sent[0].body).toContain('[PHONE_1]');
    await expect(page.locator('#reply')).toHaveText(`You said: Call me at ${PHONE} or write to ${EMAIL}`);
    await page.close();
  });
}

test('chatgpt.com: a reloaded chat, built into the page, shows real values', async () => {
  // Runs after the chatgpt.com send above, which created CHAT_ID.
  const page = await context.newPage();
  await page.goto(`https://chatgpt.com/c/${CHAT_ID}`);
  await expect(page.locator('#ssr')).toHaveText(`Call me at ${PHONE} or write to ${EMAIL}`);
  expect(hostLog().some((m) => m.op === 'page_data')).toBe(true);
  await page.close();
});

test('the popup shows the extension and app versions, and the app is told the extension\'s', async () => {
  const version = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await expect(popup.locator('#versions')).toHaveText(`Extension ${version} · Veil app mock`);
  expect(hostLog().some((m) => m.op === 'status' && (m.payload as { extension?: string } | null)?.extension === version)).toBe(true);
  await popup.close();
});

test('requests that carry no chat text never reach the host', async () => {
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/');
  const before = received.length;
  const path = '/backend-api/settings/user';
  const status = await page.evaluate(
    async ([p, email]) => {
      const body = { messages: [{ content: { parts: [`settings for ${email}`] } }] };
      const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      await r.text();
      return r.status;
    },
    [path, EMAIL] as const,
  );
  expect(status).toBe(200);
  // Left alone: the site got it as the page sent it, and the host never saw it.
  expect(received.slice(before).map((r) => r.path)).toEqual([path]);
  expect(hostLog().some((m) => m.payload?.path === path)).toBe(false);
  // The log does record what the host is sent: the sends above are in it.
  expect(hostLog().filter((m) => m.op === 'request').length).toBeGreaterThanOrEqual(2);
  await page.close();
});

test('with Veil not running, sending is blocked, and pages still load', async () => {
  writeFileSync(join(hostDir, 'stopped'), '');
  try {
    const page = await context.newPage();
    await page.goto('https://chatgpt.com/');
    await expect(page.locator('#box')).toBeVisible();
    const before = received.length;
    await send(page, `write to ${EMAIL}`);
    await expect(page.locator('#status')).toHaveText('status 403', { timeout: 15_000 });
    expect(received.length).toBe(before);
    await expect(page.locator('veil-banner')).toHaveCount(1);
    await page.close();
  } finally {
    rmSync(join(hostDir, 'stopped'));
  }
});

test('with "send without protection" on, sends go through unchanged while Veil is not running', async () => {
  await setUnprotected('chatgpt.com', true);
  writeFileSync(join(hostDir, 'stopped'), '');
  try {
    const page = await context.newPage();
    await page.goto('https://chatgpt.com/');
    const before = received.length;
    await send(page, `write to ${EMAIL}`);
    await expect(page.locator('#status')).toHaveText('status 200 done', { timeout: 15_000 });
    const sent = received.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain(EMAIL);
    await page.close();
  } finally {
    rmSync(join(hostDir, 'stopped'));
    await setUnprotected('chatgpt.com', false);
  }
});
