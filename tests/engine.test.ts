// The built-in engine with the real WebAssembly: the package built by
// `scripts/build-npm.sh` in veil-engine. Skipped without it.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalEngine, type Store } from '../src/local/engine';
import { SessionMemory, type SessionArea } from '../src/local/memory';

const dir = process.env.VEIL_ENGINE_DIR ?? join(__dirname, '../node_modules/veil-engine');
const have = existsSync(join(dir, 'veil_engine_wasm_bg.wasm'));

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

/** A stand-in for chrome.storage.session. */
function sessionArea(): SessionArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async () => Object.fromEntries(data),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, structuredClone(v))),
    remove: async (keys) => void [keys].flat().forEach((k) => data.delete(k)),
  };
}

function engine(store = memoryStore(), session = sessionArea(), now = { t: 1_700_000_000_000 }) {
  return { store, session, now, engine: new LocalEngine({ wasm, store, memory: new SessionMemory(session), now: () => now.t, version: '0.5.0' }) };
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
  it('redacts without a license key, and not when it is turned off', async () => {
    const { engine: e } = engine();
    expect(await e.available()).toBe(true);
    const done = await e.ask<{ action: string }>('request', send('mail ana@example.com'));
    expect(done.ok && done.result.action).toBe('rewrite');
    await e.setEnabled(false);
    expect(await e.available()).toBe(false);
  });

  it('restores a chat after Chrome stops the service worker, but not after the browser restarts', async () => {
    const first = engine();
    const sent = await first.engine.ask<{ body: string }>('request', send('write to ana@example.com'));
    const body = JSON.parse(Buffer.from((sent as { result: { body: string } }).result.body, 'base64').toString());
    const text = body.messages[0].content.parts[0] as string;
    expect(text).toBe(`write to ${ph('EMAIL', 1)}`);
    await new Promise((r) => setTimeout(r, 20));

    const reopen = async (e: LocalEngine) => {
      const load = await e.ask<{ ticket: string }>('request', { site: 'chatgpt.com', method: 'GET', path: '/backend-api/conversations/conv-1' });
      const page = JSON.stringify({ title: `Mail ${ph('EMAIL', 1)}`, mapping: { x: { message: { content: { parts: [text] } } } } });
      const restored = await e.ask<{ chunk: string }>('response', {
        ticket: (load as { result: { ticket: string } }).result.ticket,
        chunk: Buffer.from(page).toString('base64'),
        done: true,
        status: 200,
        content_type: 'application/json',
      });
      return JSON.parse(Buffer.from((restored as { result: { chunk: string } }).result.chunk, 'base64').toString());
    };
    // The same session, a new service worker: the values are still there.
    const sameSession = engine(first.store, first.session);
    expect((await reopen(sameSession.engine)).title).toBe('Mail ana@example.com');
    // A new browser session: the session storage is empty, the placeholders stay.
    const nextSession = engine(first.store);
    expect((await reopen(nextSession.engine)).title).toBe(`Mail ${ph('EMAIL', 1)}`);
  });

  it('keeps values only in the session storage, never in the storage that is written to disk', async () => {
    const { engine: e, session, store } = engine();
    await e.ask('request', send('mail ana.popescu@example.com'));
    await new Promise((r) => setTimeout(r, 1200));
    expect(JSON.stringify([...store.data])).not.toContain('ana.popescu');
    expect(JSON.stringify([...session.data])).toContain('ana.popescu');
  });

  it('forgets values now when asked, and keeps the settings', async () => {
    const { engine: e, session } = engine();
    await e.patchConfig({ behavior: { fail_closed: false } } as never);
    await e.ask('request', send('mail ana@example.com'));
    await new Promise((r) => setTimeout(r, 1200));
    await e.clearVault();
    expect(JSON.stringify([...session.data])).not.toContain('ana@example.com');
    expect((await e.config()).settings.behavior.fail_closed).toBe(false);
  });

  it('runs the built-in detectors only, and refuses settings it can\'t use', async () => {
    const { engine: e } = engine();
    const view = await e.rulesView();
    await e.putRules({ ...view.rules, dictionary: [{ term: 'Project Halcyon', type: 'CODENAME', match_case: false }] });
    const test = await e.testRules({ text: 'about project halcyon, ana@example.com', rules: null });
    expect(test.redacted).toBe(`about project halcyon, ${ph('EMAIL', 1)}`);
    await expect(e.patchConfig({ behavior: { placeholder_format: 'no type' } } as never)).rejects.toThrow();
    expect((await e.config()).settings.behavior.placeholder_format).not.toBe('no type');
    await e.patchConfig({ behavior: { fail_closed: false } } as never);
    expect((await e.config()).settings.behavior.fail_closed).toBe(false);
  });

  it('counts what it did today, for the dashboard', async () => {
    const { engine: e } = engine();
    const d = await e.ask<{ ticket: string }>('request', send('mail ana@example.com'));
    await e.ask('response', { ticket: (d as { result: { ticket: string } }).result.ticket, chunk: '', done: true, status: 200, content_type: 'text/event-stream' });
    const status = await e.status();
    expect(status.activated).toBe(true);
    expect(status.redacted_today).toBe(1);
    expect(status.requests_today).toBe(1);
    expect((await e.activity())[0]).toMatchObject({ channel: 'extension', provider: 'chatgpt.com', outcome: 'sent' });
  });
});
