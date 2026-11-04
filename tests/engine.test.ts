// The built-in engine with the real WebAssembly. Needs the package built with
// the test license: `scripts/build-npm.sh --dev-license` in veil-engine. Skipped without it.

import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { LocalEngine, type Store } from '../src/local/engine';
import { BrowserVault } from '../src/local/vault';

const dir = process.env.VEIL_ENGINE_DEV_DIR ?? join(__dirname, '../../veil-engine/target/npm-dev');
const licensePath = process.env.VEIL_TEST_LICENSE ?? join(__dirname, '../../veil-engine/fixtures/license/test.veil-license');
const have = existsSync(join(dir, 'veil_engine_wasm_bg.wasm')) && existsSync(licensePath);

// Placeholders are built at run time so nothing on the way rewrites them.
const ph = (kind: string, n: number) => `${'['}${kind}_${n}${']'}`;

function memoryStore(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
}

async function wasm() {
  const mod = (await import(join(dir, 'veil_engine_wasm.js'))) as typeof import('veil-engine');
  await mod.default({ module_or_path: readFileSync(join(dir, 'veil_engine_wasm_bg.wasm')) });
  return mod;
}

function engine(store = memoryStore(), idb = new IDBFactory(), now = { t: 1_700_000_000_000 }) {
  return { store, idb, now, engine: new LocalEngine({ wasm, store, vault: new BrowserVault(idb), now: () => now.t, version: '0.5.0' }) };
}

const send = (text: string, conversation = 'conv-1') => ({
  site: 'chatgpt.com',
  method: 'POST',
  path: '/backend-api/f/conversation',
  body: Buffer.from(
    JSON.stringify({
      action: 'next',
      conversation_id: conversation,
      messages: [{ id: 'm', author: { role: 'user' }, content: { content_type: 'text', parts: [text] }, metadata: {} }],
      parent_message_id: 'root',
      model: 'auto',
    }),
  ).toString('base64'),
});

describe.skipIf(!have)('the built-in engine', () => {
  it('needs a license key before it will redact anything', async () => {
    const { engine: e } = engine();
    expect(await e.available()).toBe(false);
    const blocked = await e.ask<{ action: string }>('request', send('mail ana@example.com'));
    expect(blocked.ok && blocked.result.action).toBe('block');
    await e.setLicense(readFileSync(licensePath, 'utf8'));
    expect(await e.available()).toBe(true);
    const done = await e.ask<{ action: string }>('request', send('mail ana@example.com'));
    expect(done.ok && done.result.action).toBe('rewrite');
  });

  it('refuses a key that is not genuine, and keeps none', async () => {
    const { engine: e, store } = engine();
    await expect(e.setLicense('VEIL1.abc.def')).rejects.toThrow();
    expect(store.data.has('license')).toBe(false);
    expect((await e.licenseView()).state).toBe('missing');
  });

  it('restores an old chat after the browser restarts, from the encrypted vault', async () => {
    const first = engine();
    await first.engine.setLicense(readFileSync(licensePath, 'utf8'));
    const sent = await first.engine.ask<{ body: string }>('request', send('write to ana@example.com'));
    const body = JSON.parse(Buffer.from((sent as { result: { body: string } }).result.body, 'base64').toString());
    const text = body.messages[0].content.parts[0] as string;
    expect(text).toBe(`write to ${ph('EMAIL', 1)}`);
    // Let the vault finish saving, then start over with only what is stored.
    await new Promise((r) => setTimeout(r, 20));

    const second = engine(first.store, first.idb);
    const load = await second.engine.ask<{ ticket: string }>('request', {
      site: 'chatgpt.com',
      method: 'GET',
      path: '/backend-api/conversations/conv-1?num_turns=10',
    });
    const ticket = (load as { result: { ticket: string } }).result.ticket;
    const page = JSON.stringify({ title: `Mail ${ph('EMAIL', 1)}`, mapping: { x: { message: { content: { parts: [text] } } } } });
    const restored = await second.engine.ask<{ chunk: string }>('response', {
      ticket,
      chunk: Buffer.from(page).toString('base64'),
      done: true,
      status: 200,
      content_type: 'application/json',
    });
    const out = JSON.parse(Buffer.from((restored as { result: { chunk: string } }).result.chunk, 'base64').toString());
    expect(out.title).toBe('Mail ana@example.com');
    expect(out.mapping.x.message.content.parts[0]).toBe('write to ana@example.com');
  });

  it('never stores a value in the clear', async () => {
    const { engine: e, idb, store } = engine();
    await e.setLicense(readFileSync(licensePath, 'utf8'));
    await e.ask('request', send('mail ana.popescu@example.com'));
    await new Promise((r) => setTimeout(r, 1200));
    expect(JSON.stringify([...store.data])).not.toContain('ana.popescu');
    const names = await (idb as unknown as { databases(): Promise<{ name: string }[]> }).databases();
    expect(names.map((n) => n.name)).toContain('veil');
  });

  it('deletes everything it keeps', async () => {
    const { engine: e, store, idb } = engine();
    await e.setLicense(readFileSync(licensePath, 'utf8'));
    await e.patchConfig({ behavior: { mode: 'audit' } } as never);
    await e.ask('request', send('mail ana@example.com'));
    await new Promise((r) => setTimeout(r, 1200));
    await e.deleteEverything();
    expect([...store.data.keys()]).toEqual([]);
    expect(await new BrowserVault(idb).loadAll()).toEqual([]);
    expect(await e.available()).toBe(false);
  });

  it('keeps settings and rules it was given, and refuses rules that do not compile', async () => {
    const { engine: e, store } = engine();
    await e.patchConfig({ behavior: { fail_closed: false } } as never);
    expect((await e.config()).settings.behavior.fail_closed).toBe(false);
    const view = await e.rulesView();
    await e.putRules({ ...view.rules, dictionary: [{ term: 'Project Halcyon', type: 'CODENAME', match_case: false }] });
    const test = await e.testRules({ text: 'about project halcyon', rules: null });
    expect(test.redacted).toBe(`about ${ph('CODENAME', 1)}`);
    await expect(e.putRules({ ...view.rules, regex: [{ name: 'bad', type: 'X', pattern: '(' }] })).rejects.toThrow();
    expect((await e.rulesView()).rules.regex).toEqual([]);
    expect(store.data.get('rules')).toBeTruthy();
  });

  it('counts what it did today, for the dashboard', async () => {
    const { engine: e } = engine();
    await e.setLicense(readFileSync(licensePath, 'utf8'));
    const d = await e.ask<{ ticket: string }>('request', send('mail ana@example.com'));
    await e.ask('response', { ticket: (d as { result: { ticket: string } }).result.ticket, chunk: '', done: true, status: 200, content_type: 'text/event-stream' });
    const status = await e.status();
    expect(status.activated).toBe(true);
    expect(status.redacted_today).toBe(1);
    expect(status.requests_today).toBe(1);
    expect((await e.activity())[0]).toMatchObject({ channel: 'extension', provider: 'chatgpt.com', outcome: 'sent' });
  });
});
