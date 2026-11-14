import { describe, expect, it, vi } from 'vitest';
import { wrapFetch, type Channel } from '../src/intercept';
import { fromBase64, toBase64, type Answer, type Op } from '../src/protocol';
import { GEMINI_CHAT_HOST, interesting, isGeminiChat } from '../src/sites';
import { chatXhr } from '../src/xhr';

const enc = new TextEncoder();
const PAGE = 'https://gemini.google.com/app/b367dae10606cbcc';
const CHAT = `https://${GEMINI_CHAT_HOST}/v1/processSession?VER=8&gsessionid=s&RID=1`;

/**
 * The browser's XMLHttpRequest, as far as the stand-in uses it (Node has
 * none). Like the browser's, its state is read through accessors on the
 * prototype, which the stand-in's own accessors take over.
 */
class FakeXhr extends EventTarget {
  static opened: string[] = [];
  _state = 0;
  _timeout = 0;
  responseType: XMLHttpRequestResponseType = '';
  withCredentials = false;
  onreadystatechange: ((e: Event) => void) | null = null;
  constructor() {
    super();
    this.addEventListener('readystatechange', (e) => this.onreadystatechange?.(e));
  }
  get readyState() {
    return this._state;
  }
  get status() {
    return 0;
  }
  get statusText() {
    return '';
  }
  get responseText() {
    return 'native';
  }
  get response(): unknown {
    return 'native';
  }
  get responseURL() {
    return '';
  }
  get responseXML() {
    return null;
  }
  get timeout() {
    return this._timeout;
  }
  set timeout(ms: number) {
    this._timeout = ms;
  }
  open(method: string, url: string) {
    FakeXhr.opened.push(`${method} ${url}`);
    this._state = 1;
  }
  setRequestHeader() {}
  send() {
    this._state = 4;
  }
  abort() {}
  getResponseHeader() {
    return 'native';
  }
  getAllResponseHeaders() {
    return 'native';
  }
  overrideMimeType() {}
}

function stream(...pieces: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  return new Response(body, { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain', 'x-a': '1' } });
}

/** Runs one request through the stand-in, recording what the page would see. */
async function run(fetchFn: typeof fetch, setup: (x: XMLHttpRequest) => void = () => {}) {
  const Xhr = chatXhr(FakeXhr as unknown as typeof XMLHttpRequest, fetchFn, isGeminiChat, () => PAGE);
  const x = new Xhr();
  const seen: string[] = [];
  x.onreadystatechange = () => seen.push(`${x.readyState}:${x.responseText.length}`);
  for (const type of ['loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend']) {
    x.addEventListener(type, () => seen.push(type));
  }
  x.open('GET', CHAT);
  setup(x);
  const done = new Promise<void>((r) => x.addEventListener('loadend', () => r()));
  x.send();
  await done;
  return { x, seen };
}

describe('the stand-in XMLHttpRequest', () => {
  it('leaves every other address to the browser', () => {
    const fetchFn = vi.fn();
    const Xhr = chatXhr(FakeXhr as unknown as typeof XMLHttpRequest, fetchFn as unknown as typeof fetch, isGeminiChat, () => PAGE);
    const x = new Xhr();
    x.open('POST', '/_/BardChatUi/data/batchexecute?rpcids=x');
    x.send('f.req=1');
    expect(FakeXhr.opened.at(-1)).toBe('POST /_/BardChatUi/data/batchexecute?rpcids=x');
    expect(x.readyState).toBe(4);
    expect(x.responseText).toBe('native');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(x instanceof (FakeXhr as unknown as typeof XMLHttpRequest)).toBe(true);
    expect(String(Xhr)).toBe('function XMLHttpRequest() { [native code] }');
  });

  it('streams the reply as the page expects, piece by piece', async () => {
    const fetchFn = vi.fn(async () => stream('14\n[[1,["no', 'op"]]]'));
    const { x, seen } = await run(fetchFn as unknown as typeof fetch, (x) => {
      x.withCredentials = true;
      x.setRequestHeader('X-Goog-Api-Key', 'k');
    });
    // `open()` fires the first readystatechange, as in the browser.
    expect(seen).toEqual(['1:0', 'loadstart', '2:0', '3:11', 'progress', '3:17', 'progress', '4:17', 'load', 'loadend']);
    expect(x.responseText).toBe('14\n[[1,["noop"]]]');
    expect(x.status).toBe(200);
    expect(x.getResponseHeader('x-a')).toBe('1');
    expect(x.getAllResponseHeaders()).toContain('x-a: 1\r\n');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CHAT);
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe('k');
  });

  it('reports a network error as the browser would', async () => {
    const { x, seen } = await run((async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    expect(seen).toEqual(['1:0', 'loadstart', '4:0', 'error', 'loadend']);
    expect(x.status).toBe(0);
  });

  it('aborts, and times out', async () => {
    let signal: AbortSignal | undefined;
    const hanging = ((_: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const Xhr = chatXhr(FakeXhr as unknown as typeof XMLHttpRequest, hanging, isGeminiChat, () => PAGE);
    const x = new Xhr();
    const seen: string[] = [];
    for (const type of ['abort', 'loadend']) x.addEventListener(type, () => seen.push(type));
    x.open('GET', CHAT);
    x.send();
    x.abort();
    expect(seen).toEqual(['abort', 'loadend']);
    expect(signal?.aborted).toBe(true);
    expect(x.readyState).toBe(0);

    vi.useFakeTimers();
    try {
      const y = new Xhr();
      const ended: string[] = [];
      for (const type of ['timeout', 'loadend']) y.addEventListener(type, () => ended.push(type));
      y.timeout = 50;
      y.open('GET', CHAT);
      y.send();
      vi.advanceTimersByTime(60);
      expect(ended).toEqual(['timeout', 'loadend']);
      expect(y.readyState).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Gemini through Veil', () => {
  it('sends the chat address to Veil with its host and the page, and nothing else on Google', async () => {
    expect(isGeminiChat(new URL(CHAT))).toBe(true);
    expect(isGeminiChat(new URL('https://gemini.google.com/v1/processSession'))).toBe(false);
    expect(interesting('gemini.google.com', 'POST', '/v1/processSession', GEMINI_CHAT_HOST)).toBe(true);
    expect(interesting('gemini.google.com', 'POST', '/_/BardChatUi/data/batchexecute', 'gemini.google.com')).toBe(false);

    const asked: { op: Op; payload: Record<string, unknown> }[] = [];
    const ch: Channel = {
      async ask<T>(op: Op, payload: unknown) {
        asked.push({ op, payload: payload as Record<string, unknown> });
        const answer: Answer = op === 'request' ? { ok: true, result: { action: 'rewrite', body: toBase64(enc.encode('count=1&req0___data__=X')), redacted: 1 } } : { ok: true, result: {} };
        return answer as Answer<T>;
      },
      allowUnprotected: async () => false,
      blocked: () => {},
      counted: () => {},
    };
    let sent = '';
    const real = vi.fn(async (req: RequestInfo | URL) => {
      if (req instanceof Request) sent = await req.text();
      return new Response('ok');
    });
    const f = wrapFetch(real as unknown as typeof fetch, 'gemini.google.com', ch, () => PAGE);
    await f(CHAT, { method: 'POST', body: 'count=1&req0___data__=Y', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(asked[0].op).toBe('request');
    expect(asked[0].payload).toMatchObject({ site: 'gemini.google.com', method: 'POST', host: GEMINI_CHAT_HOST, page: '/app/b367dae10606cbcc' });
    expect(new TextDecoder().decode(fromBase64(asked[0].payload.body as string))).toBe('count=1&req0___data__=Y');
    expect(sent).toBe('count=1&req0___data__=X');

    // Google's other calls go straight through.
    await f('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=x', { method: 'POST', body: 'f.req=1' });
    await f('https://play.google.com/log', { method: 'POST', body: 'x' });
    expect(asked).toHaveLength(1);
  });
});
