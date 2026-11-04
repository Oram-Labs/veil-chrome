import { describe, expect, it } from 'vitest';
import type { Answer, Op } from '../src/protocol';
import { chatKey, makeRouter, type Engine, type Link, type LocalLink, type Pins } from '../src/router';

const unreachable: Answer = { ok: false, error: 'no_host' };

function link(answer: (op: Op, payload: unknown) => Answer): Link & { calls: [Op, unknown][] } {
  const calls: [Op, unknown][] = [];
  return {
    calls,
    ask: async (op, payload) => {
      calls.push([op, payload]);
      return answer(op, payload) as never;
    },
  };
}

function pins(): Pins & { all: Map<string, Engine> } {
  const all = new Map<string, Engine>();
  return { all, get: async (k) => all.get(k), set: async (k, v) => void all.set(k, v) };
}

const rewrite = (ticket = 'abc'): Answer => ({ ok: true, result: { action: 'rewrite', body: 'x', ticket, redacted: 1 } });
const pass: Answer = { ok: true, result: { action: 'pass', redacted: 0 } };
const claude = { site: 'claude.ai', method: 'POST', path: '/api/x/completion', body: 'e30=' };
const chatUrl = 'https://claude.ai/chat/11111111-2222-4333-8444-555555555555';

function setup(opts: { app: (op: Op, p: unknown) => Answer; local?: (op: Op, p: unknown) => Answer; available?: boolean }) {
  const app = link(opts.app);
  const l = link(opts.local ?? (() => rewrite('t1')));
  let available = opts.available ?? true;
  const local: LocalLink & { calls: [Op, unknown][] } = { ...l, available: async () => available };
  const p = pins();
  let now = 1_000;
  const router = makeRouter(app, local, p, () => now);
  return { app, local, pins: p, router, setAvailable: (v: boolean) => (available = v), tick: (ms: number) => (now += ms) };
}

describe('chat keys', () => {
  it('come from the page address', () => {
    expect(chatKey(chatUrl, 'claude.ai')).toBe('claude.ai:11111111-2222-4333-8444-555555555555');
    expect(chatKey('https://chatgpt.com/c/abc-123', 'chatgpt.com')).toBe('chatgpt.com:abc-123');
    expect(chatKey('https://chatgpt.com/g/g-x/c/abc-123', 'chatgpt.com')).toBe('chatgpt.com:abc-123');
    expect(chatKey('https://chatgpt.com/', 'chatgpt.com')).toBeNull();
    expect(chatKey('https://claude.ai/new', 'claude.ai')).toBeNull();
    expect(chatKey(undefined, 'claude.ai')).toBeNull();
  });
});

describe('the app comes first', () => {
  it('answers whenever it can be reached', async () => {
    const t = setup({ app: () => rewrite('app-ticket') });
    const a = await t.router.route('request', claude, { tabUrl: chatUrl });
    expect(a).toEqual(rewrite('app-ticket'));
    expect(t.local.calls).toEqual([]);
    expect(t.pins.all.get('claude.ai:11111111-2222-4333-8444-555555555555')).toBe('app');
  });

  it('is asked for the status first, and the built-in engine answers when it is not there', async () => {
    const t = setup({ app: () => unreachable, local: () => ({ ok: true, result: { activated: true } }) });
    expect(await t.router.route('status', {}, {})).toEqual({ ok: true, result: { activated: true, engine: 'builtin' } });
    const ok = setup({ app: () => ({ ok: true, result: { activated: true } }) });
    expect(await ok.router.route('status', {}, {})).toEqual({ ok: true, result: { activated: true } });
    expect(ok.local.calls).toEqual([]);
  });

  it('is refused by the failure alone, never by an answer: a block from the app is the app\'s', async () => {
    const t = setup({ app: () => ({ ok: true, result: { action: 'block', message: 'Veil is paused', redacted: 0 } }) });
    const a = await t.router.route('request', claude, { tabUrl: chatUrl });
    expect((a as { ok: true; result: { action: string } }).result.action).toBe('block');
    expect(t.local.calls).toEqual([]);
  });
});

describe('the built-in engine', () => {
  it('answers when the app is not there, with a ticket marked as its own', async () => {
    const t = setup({ app: () => unreachable });
    const a = await t.router.route('request', claude, { tabUrl: chatUrl });
    expect(a).toEqual({ ok: true, result: { action: 'rewrite', body: 'x', ticket: 'local:t1', redacted: 1 } });
    expect(t.pins.all.get('claude.ai:11111111-2222-4333-8444-555555555555')).toBe('local');
  });

  it('gets the reply of its own tickets, and the app its own', async () => {
    const t = setup({ app: () => ({ ok: true, result: { chunk: 'from-app' } }), local: () => ({ ok: true, result: { chunk: 'from-local' } }) });
    const own = await t.router.route('response', { ticket: 'local:t1', chunk: 'x', done: true }, {});
    expect(own).toEqual({ ok: true, result: { chunk: 'from-local' } });
    expect(t.local.calls[0]![1]).toEqual({ ticket: 't1', chunk: 'x', done: true });
    expect(await t.router.route('response', { ticket: 'beef', chunk: 'x', done: true }, {})).toEqual({ ok: true, result: { chunk: 'from-app' } });
  });

  it('is not used without a license, or when turned off: the failure stands', async () => {
    const t = setup({ app: () => unreachable, available: false });
    expect(await t.router.route('request', claude, { tabUrl: chatUrl })).toEqual(unreachable);
    expect(t.local.calls).toEqual([]);
    expect(await t.router.route('status', {}, {})).toEqual(unreachable);
  });

  it('keeps a chat it started, even when the app starts', async () => {
    const t = setup({ app: () => unreachable });
    await t.router.route('request', claude, { tabUrl: chatUrl });
    // The app is up now.
    const up = setup({ app: () => rewrite('app-ticket') });
    up.pins.all.set('claude.ai:11111111-2222-4333-8444-555555555555', 'local');
    const a = await up.router.route('request', claude, { tabUrl: chatUrl });
    expect((a as { ok: true; result: { ticket: string } }).result.ticket).toBe('local:t1');
    expect(up.app.calls).toEqual([]);
  });

  it('keeps a chat the app started, and blocks it rather than send it through the other engine', async () => {
    const t = setup({ app: () => unreachable });
    t.pins.all.set('claude.ai:11111111-2222-4333-8444-555555555555', 'app');
    const a = await t.router.route('request', claude, { tabUrl: chatUrl });
    expect(a).toMatchObject({ ok: true, result: { action: 'block' } });
    expect(JSON.stringify(a)).toContain('Open Veil');
    expect(t.local.calls).toEqual([]);
  });

  it('blocks a chat it started when its license is gone', async () => {
    const t = setup({ app: () => unreachable, available: false });
    t.pins.all.set('claude.ai:11111111-2222-4333-8444-555555555555', 'local');
    const a = await t.router.route('request', claude, { tabUrl: chatUrl });
    expect(a).toMatchObject({ ok: true, result: { action: 'block' } });
    expect(JSON.stringify(a)).toContain('license');
  });

  it('does not tie a chat to an engine that sent its message as it was', async () => {
    const t = setup({ app: () => unreachable, local: () => pass });
    await t.router.route('request', claude, { tabUrl: chatUrl });
    expect(t.pins.all.size).toBe(0);
  });

  it('remembers a new chat for its tab, for a while', async () => {
    const t = setup({ app: () => unreachable });
    await t.router.route('request', claude, { tabUrl: 'https://claude.ai/new', tabId: 7 });
    const answer = await t.router.route('request', claude, { tabUrl: chatUrl, tabId: 7 });
    expect((answer as { ok: true; result: { ticket: string } }).result.ticket).toBe('local:t1');
    expect(t.pins.all.get('claude.ai:11111111-2222-4333-8444-555555555555')).toBe('local');
  });

  it('does not hand a new chat\'s engine to another tab, or to a chat opened much later', async () => {
    const t = setup({ app: () => unreachable });
    await t.router.route('request', claude, { tabUrl: 'https://claude.ai/new', tabId: 7 });
    t.setAvailable(true);
    const up = makeRouter(link(() => rewrite('app')), { ...link(() => rewrite('t2')), available: async () => true }, t.pins, () => 1_000);
    expect(await up.route('response', { ticket: 'x', done: true }, {})).toBeTruthy();
    // Another tab: its own, unpinned, so the app answers.
    const other = await t.router.route('request', claude, { tabUrl: chatUrl, tabId: 8 });
    expect((other as { ok: true; result: { ticket: string } }).result.ticket).toBe('local:t1');
  });

  it('follows a draft: a file redacted by one engine means the message goes to it', async () => {
    const t = setup({ app: () => unreachable, local: () => ({ ok: true, result: { action: 'replace', text: 'x', redacted: 1, pages: 1 } }) });
    const doc = { site: 'chatgpt.com', page: '/', draft: 'd1', name: 'a.txt', data: 'e30=' };
    await t.router.route('document', doc, { tabUrl: 'https://chatgpt.com/', tabId: 3 });
    expect(t.pins.all.get('chatgpt.com:draft:d1')).toBe('local');
    const send = { site: 'chatgpt.com', method: 'POST', path: '/backend-api/f/conversation', draft: 'd1', body: 'e30=' };
    const up = setup({ app: () => rewrite('app') });
    up.pins.all.set('chatgpt.com:draft:d1', 'local');
    const a = await up.router.route('request', send, { tabUrl: 'https://chatgpt.com/', tabId: 3 });
    expect((a as { ok: true; result: { ticket: string } }).result.ticket).toBe('local:t1');
  });
});

describe('other operations', () => {
  it('observing is the app\'s alone, and answers "not written" without it', async () => {
    const t = setup({ app: () => unreachable });
    expect(await t.router.route('observe', { site: 'claude.ai', kind: 'fetch' }, {})).toEqual({ ok: true, result: { written: false } });
  });

  it('opening the app is the app\'s alone', async () => {
    const t = setup({ app: () => unreachable });
    expect(await t.router.route('open', {}, {})).toEqual(unreachable);
    expect(t.local.calls).toEqual([]);
  });

  it('page data goes to the chat\'s engine, or the app first', async () => {
    const t = setup({ app: () => unreachable, local: () => ({ ok: true, result: { text: 'restored', restored: 1 } }) });
    const data = { site: 'chatgpt.com', conversation: 'abc', text: 'x' };
    expect(await t.router.route('page_data', data, {})).toEqual({ ok: true, result: { text: 'restored', restored: 1 } });
    t.pins.all.set('chatgpt.com:abc', 'app');
    expect(await t.router.route('page_data', data, {})).toEqual(unreachable);
  });
});
