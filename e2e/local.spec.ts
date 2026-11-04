// End to end for the built-in engine: Chromium with the extension, no Veil
// app (no native host is registered), and local stand-ins for claude.ai and
// chatgpt.com. Checks that the extension redacts and restores by itself,
// leaves attached files to the app, remembers real values only for the
// browser session and never on disk, forgets everything on request, and keeps
// a chat with the engine that started it when the app appears.
//
// The extension is built here, with the installed engine package or the one
// VEIL_ENGINE_DIR points at.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { bundle } from '../scripts/bundle.mjs';
import { CHAT_ID, selfSignedCert, startSites, type Received } from './sites';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const engineDir = process.env.VEIL_ENGINE_DIR ?? resolve(root, 'node_modules/veil-engine');
const EXTENSION_ID = 'kgkmpkkhpegbhjloakfcibgfgpmfdjil';
const EMAIL = 'ana.popescu@example.com';
const PHONE = '+40 721 234 567';

let work: string;
let extension: string;
let profile: string;
let hostDir: string;
let context: BrowserContext;
let received: Received[];
let sitesPort: number;
let stopSites: () => void;

async function launch(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP claude.ai 127.0.0.1:${sitesPort}, MAP chatgpt.com 127.0.0.1:${sitesPort}`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });
}

/** Registers a stand-in Veil app, as if it were installed and running. */
function installApp(): void {
  const host = join(work, 'mock-host.sh');
  writeFileSync(host, `#!/bin/sh\nexport MOCK_HOST_DIR='${hostDir}'\nexec '${process.execPath}' '${join(here, 'mock-host.mjs')}' "$@"\n`);
  chmodSync(host, 0o755);
  mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
  writeFileSync(
    join(profile, 'NativeMessagingHosts/com.veil.app.native.json'),
    JSON.stringify({ name: 'com.veil.app.native', description: 'Veil (stand-in)', path: host, type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }),
  );
}

function hostLog(): { op: string }[] {
  const log = join(hostDir, 'log.jsonl');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill('#box', text);
  await page.click('#send');
}

async function options(screen = 'dashboard'): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#/${screen}`);
  await expect(page.locator('main h1')).toBeVisible({ timeout: 15_000 });
  return page;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!existsSync(join(engineDir, 'veil_engine_wasm_bg.wasm')), 'install the veil-engine package first');
  work = mkdtempSync(join(tmpdir(), 'veil-local-e2e-'));
  hostDir = join(work, 'host');
  mkdirSync(hostDir);
  profile = join(work, 'profile');
  extension = join(work, 'extension');
  process.env.VEIL_ENGINE_DIR = engineDir;
  await bundle(root, extension, 'silent');
  const sites = await startSites(selfSignedCert(work));
  received = sites.received;
  sitesPort = sites.port;
  stopSites = () => sites.server.close();
  context = await launch();
});

test.afterAll(async () => {
  await context?.close();
  stopSites?.();
  if (work) rmSync(work, { recursive: true, force: true });
});

test('without the app, the built-in engine protects at once, and the popup says so', async () => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await expect(popup.locator('#versions')).toContainText('Built-in engine');
  await expect(popup.locator('#settings')).toBeVisible();
  await expect(popup.locator('#download')).toHaveText('Get the Veil app');
  await popup.close();
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

test('attached files are left to the app: sent as they are with a notice, or held back with Block', async () => {
  const page = await context.newPage();
  await page.goto('https://claude.ai/chat/11111111-2222-4333-8444-555555555555');
  await page.setInputFiles('#file', [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(`Contact ${EMAIL}`) }]);
  await expect(page.locator('#uploads')).toContainText('notes.txt 200', { timeout: 15_000 });
  await expect(page.locator('veil-banner')).toHaveCount(1);
  await page.close();

  const behavior = await options('behavior');
  await behavior.getByRole('group', { name: 'Images, files and unrecognised requests' }).getByRole('button', { name: 'Block' }).click();
  await expect(behavior.getByRole('button', { name: 'Block', pressed: true })).toBeVisible();
  await behavior.close();
  const again = await context.newPage();
  await again.goto('https://claude.ai/chat/11111111-2222-4333-8444-555555555555');
  const before = received.length;
  await again.setInputFiles('#file', [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(`Contact ${EMAIL}`) }]);
  await expect(again.locator('veil-banner')).toHaveCount(1, { timeout: 15_000 });
  expect(received.slice(before).filter((r) => r.path === '/upload')).toHaveLength(0);
  await again.close();
});

test('when Chrome stops the service worker, a chat still shows real values', async () => {
  const page = await context.newPage();
  await page.goto(`https://chatgpt.com/c/${CHAT_ID}`);
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.reload();
  await expect(page.locator('#ssr')).toHaveText(`Call me at ${PHONE} or write to ${EMAIL}`, { timeout: 15_000 });
  await page.close();
});

/** Every file of the profile that belongs to the extension, as text. */
function extensionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.includes(EXTENSION_ID)) out.push(path);
    }
  };
  walk(profile);
  return out;
}

test('nothing the built-in engine keeps on disk holds a real value, and a new browser session shows placeholders', async () => {
  await context.close();
  const files = extensionFiles();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const bytes = readFileSync(file);
    for (const needle of [EMAIL, '721 234 567']) {
      expect(bytes.includes(Buffer.from(needle)), `${file} holds ${needle}`).toBe(false);
      expect(bytes.includes(Buffer.from(needle, 'utf16le')), `${file} holds ${needle}`).toBe(false);
    }
  }
  expect(files.some((f) => f.includes('IndexedDB'))).toBe(false);

  context = await launch();
  const page = await context.newPage();
  await page.goto(`https://chatgpt.com/c/${CHAT_ID}`);
  await expect(page.locator('#ssr')).toContainText('[EMAIL_1]', { timeout: 15_000 });
  await expect(page.locator('#ssr')).not.toContainText(EMAIL);
  await page.close();
});

test('the settings page shows what it did today, and the rules apply at once', async () => {
  const page = await options('dashboard');
  await expect(page.getByText(/value\(s\) hidden/)).toBeVisible({ timeout: 15_000 });
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#/playground`);
  await page.locator('#input').fill(`write to ${EMAIL}`);
  await expect(page.getByText('[EMAIL_1]').first()).toBeVisible({ timeout: 15_000 });
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#/rules`);
  await expect(page.getByText('Built-in detectors')).toBeVisible();
  await expect(page.getByText('Custom dictionary')).toHaveCount(0);
  await page.close();
});

test('a chat the built-in engine started stays with it when the app appears, and a new chat uses the app', async () => {
  const old = await context.newPage();
  await old.goto('https://claude.ai/');
  await send(old, `first, write to ${EMAIL}`);
  await expect(old.locator('#status')).toHaveText('status 200 done', { timeout: 15_000 });
  // The site gives the chat an address once it has started, in the same tab.
  await old.evaluate(() => history.pushState(null, '', '/chat/11111111-2222-4333-8444-555555555555'));
  installApp();
  const before = received.length;
  await send(old, `again, write to ${EMAIL}`);
  await expect.poll(() => received.length, { timeout: 15_000 }).toBeGreaterThan(before);
  expect(received.slice(before)[0].body).toContain('[EMAIL_');
  expect(received.slice(before)[0].body).not.toContain(EMAIL);
  expect(hostLog().filter((m) => m.op === 'request')).toHaveLength(0);
  await old.close();

  // A chat opened later, from the same address, is the built-in engine's still.
  const again = await context.newPage();
  await again.goto('https://claude.ai/chat/11111111-2222-4333-8444-555555555555');
  const beforeThird = received.length;
  await send(again, `third, write to ${EMAIL}`);
  await expect.poll(() => received.length, { timeout: 15_000 }).toBeGreaterThan(beforeThird);
  expect(received[received.length - 1].body).not.toContain(EMAIL);
  expect(hostLog().filter((m) => m.op === 'request')).toHaveLength(0);
  await again.close();

  // A different, new chat goes to the app.
  const fresh = await context.newPage();
  await fresh.goto('https://chatgpt.com/');
  await send(fresh, `hello ${EMAIL}`);
  await expect(fresh.locator('#status')).toHaveText('status 200 done', { timeout: 15_000 });
  expect(hostLog().filter((m) => m.op === 'request').length).toBeGreaterThan(0);
  await fresh.close();
  // The app is closed again.
  writeFileSync(join(hostDir, 'stopped'), '');
});

test('"Forget values now" forgets the values and keeps the settings', async () => {
  const site = await context.newPage();
  await site.goto('https://chatgpt.com/');
  await send(site, `Call me at ${PHONE} or write to ${EMAIL}`);
  await expect(site.locator('#reply')).toHaveText(`You said: Call me at ${PHONE} or write to ${EMAIL}`, { timeout: 15_000 });
  await site.close();
  const chat = await context.newPage();
  await chat.goto(`https://chatgpt.com/c/${CHAT_ID}`);
  await expect(chat.locator('#ssr')).toHaveText(`Call me at ${PHONE} or write to ${EMAIL}`, { timeout: 15_000 });

  const page = await options('dashboard');
  page.on('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: /forget values now/i }).click();
  await expect(page.getByText('Values forgotten')).toBeVisible();
  // The settings stay: Block for files was chosen above.
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#/behavior`);
  await expect(page.getByRole('button', { name: 'Block', pressed: true })).toBeVisible({ timeout: 15_000 });
  await page.close();

  await chat.reload();
  await expect(chat.locator('#ssr')).toContainText('[EMAIL_1]', { timeout: 15_000 });
  await expect(chat.locator('#ssr')).not.toContainText(EMAIL);
  await chat.close();
});

test('with the built-in engine turned off, sending waits for the app', async () => {
  const page = await options('dashboard');
  await page.getByRole('switch', { name: 'Use the built-in engine' }).click();
  await page.close();
  const site = await context.newPage();
  await site.goto('https://chatgpt.com/');
  await send(site, `write to ${EMAIL}`);
  await expect(site.locator('#status')).toHaveText('status 403', { timeout: 15_000 });
  await site.close();
});
