// End to end for the built-in engine: Chromium with the extension, no Veil
// app (no native host is registered), and local stand-ins for claude.ai and
// chatgpt.com. Checks that the extension redacts and restores by itself once
// a license key is in its settings, keeps working after the browser restarts,
// forgets everything on request, and keeps a chat with the engine that
// started it when the app appears.
//
// The extension is built here with the engine package that accepts the test
// license (`scripts/build-npm.sh --dev-license` in veil-engine; VEIL_ENGINE_DIR
// points at it, and VEIL_TEST_LICENSE at the key).

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { bundle } from '../scripts/bundle.mjs';
import { CHAT_ID, selfSignedCert, startSites, type Received } from './sites';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const engineDir = process.env.VEIL_ENGINE_DIR ?? resolve(root, '../veil-engine/target/npm-dev');
const licenseFile = process.env.VEIL_TEST_LICENSE ?? resolve(root, '../veil-engine/fixtures/license/test.veil-license');
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

async function activate(): Promise<void> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  await options.fill('#license-key', readFileSync(licenseFile, 'utf8').trim());
  await options.getByRole('button', { name: /activate/i }).click();
  await expect(options.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 });
  await options.close();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!existsSync(join(engineDir, 'veil_engine_wasm_bg.wasm')) || !existsSync(licenseFile), 'build veil-engine with `scripts/build-npm.sh --dev-license` first');
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

test('without a license key and without the app, sending waits, and the popup points to the built-in engine', async () => {
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/');
  const before = received.length;
  await send(page, `write to ${EMAIL}`);
  await expect(page.locator('#status')).toHaveText('status 403', { timeout: 15_000 });
  expect(received.length).toBe(before);
  await page.close();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await expect(popup.locator('#settings')).toBeVisible();
  await expect(popup.locator('#help')).toContainText('license key');
  await popup.close();
});

test('a wrong license key is refused, the right one activates', async () => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  await options.fill('#license-key', 'VEIL1.not.real');
  await options.getByRole('button', { name: /activate/i }).click();
  await expect(options.locator('.bad, [role="alert"]').first()).toBeVisible();
  await options.close();
  await activate();
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

test('attached text files, .env included, go up redacted', async () => {
  const page = await context.newPage();
  await page.goto('https://claude.ai/chat/11111111-2222-4333-8444-555555555555');
  const before = received.length;
  await page.setInputFiles('#file', [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(`Contact ${EMAIL} about the invoice`) },
    { name: '.env', mimeType: 'application/octet-stream', buffer: Buffer.from(`MAIL=${EMAIL}\n`) },
  ]);
  await expect(page.locator('#uploads')).toContainText('notes (redacted).txt 200', { timeout: 15_000 });
  await expect(page.locator('#uploads')).toContainText('.env (redacted).txt 200');
  const bodies = received.slice(before).filter((r) => r.path === '/upload').map((r) => r.body).join('\n');
  expect(bodies).not.toContain(EMAIL);
  expect(bodies).toContain('[EMAIL_');
  await page.close();
});

test('after the browser restarts, a chat made before still shows real values', async () => {
  await context.close();
  context = await launch();
  const page = await context.newPage();
  await page.goto(`https://chatgpt.com/c/${CHAT_ID}`);
  await expect(page.locator('#ssr')).toHaveText(`Call me at ${PHONE} or write to ${EMAIL}`, { timeout: 15_000 });
  await page.close();
});

test('the settings page shows what it did today, and the rules apply at once', async () => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${EXTENSION_ID}/options.html#/dashboard`);
  await expect(options.getByText(/value\(s\) hidden/)).toBeVisible({ timeout: 15_000 });
  await options.goto(`chrome-extension://${EXTENSION_ID}/options.html#/playground`);
  await options.locator('#input').fill(`write to ${EMAIL}`);
  await expect(options.getByText('[EMAIL_1]').first()).toBeVisible({ timeout: 15_000 });
  await options.close();
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

test('"Delete everything" forgets the values, the settings and the key', async () => {
  const options = await context.newPage();
  options.on('dialog', (d) => void d.accept());
  await options.goto(`chrome-extension://${EXTENSION_ID}/options.html#/dashboard`);
  await options.getByRole('button', { name: /delete everything/i }).click();
  await expect(options.locator('#license-key')).toBeVisible({ timeout: 15_000 });
  const stored = await options.evaluate(() => chrome.storage.local.get(null));
  expect(Object.keys(stored)).not.toContain('license');
  await options.close();

  // The key is gone, so sending waits again.
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/');
  await send(page, `write to ${EMAIL}`);
  await expect(page.locator('#status')).toHaveText('status 403', { timeout: 15_000 });
  await page.close();
});

test('an activated app gives its license key to the built-in engine, which then works without the app', async () => {
  installApp();
  writeFileSync(join(hostDir, 'license.key'), readFileSync(licenseFile, 'utf8'));
  rmSync(join(hostDir, 'stopped'), { force: true });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await expect(popup.locator('#versions')).toContainText('Veil app mock');
  await expect.poll(async () => Object.keys(await popup.evaluate(() => chrome.storage.local.get(null)))).toContain('license');
  await popup.close();

  writeFileSync(join(hostDir, 'stopped'), '');
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/');
  const before = received.length;
  await send(page, `write to ${EMAIL}`);
  await expect.poll(() => received.length, { timeout: 15_000 }).toBeGreaterThan(before);
  expect(received[received.length - 1].body).not.toContain(EMAIL);
  await page.close();
});
