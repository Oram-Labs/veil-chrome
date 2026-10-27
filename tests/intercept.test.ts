import { describe, expect, it, vi } from 'vitest';
import { wrapFetch, type Channel } from '../src/intercept';
import { fromBase64, toBase64, type Answer, type Decision, type Op } from '../src/protocol';

const enc = new TextEncoder();
const dec = new TextDecoder();
const BASE = 'https://chatgpt.com/c/123';

interface Asked {
  op: Op;
  payload: Record<string, unknown>;
}

function channel(answer: (a: Asked) => Answer, unprotected = false) {
  const asked: Asked[] = [];
  const blocked: string[] = [];
  const counted: number[] = [];
  const ch: Channel = {
    async ask<T>(op: Op, payload: unknown) {
      const a = { op, payload: payload as Record<string, unknown> };
      asked.push(a);
      return answer(a) as Answer<T>;
    },
    allowUnprotected: async () => unprotected,
    blocked: (m) => blocked.push(m),
    counted: (n) => counted.push(n),
  };
  return { ch, asked, blocked, counted };
}

function sse(...chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'content-length': '999' } });
}

const send = { method: 'POST', body: JSON.stringify({ messages: [{ content: { parts: ['mail ana@example.com'] } }] }) };

describe('wrapFetch', () => {
  it('leaves other requests alone', async () => {
    const real = vi.fn(async () => new Response('ok'));
    const { ch, asked } = channel(() => ({ ok: true, result: { action: 'pass', redacted: 0 } }));
    const f = wrapFetch(real as typeof fetch, 'chatgpt.com', ch, () => BASE);
    await f('/backend-api/sentinel/chat-requirements', { method: 'POST', body: '{}' });
    await f('https://example.com/backend-api/conversation', send);
    expect(asked).toHaveLength(0);
    expect(real).toHaveBeenCalledTimes(2);
  });

  it('sends the redacted body and restores the reply as it streams', async () => {
    let sent = '';
    const real = vi.fn(async (req: Request) => {
      sent = await req.text();
      return sse('data: {"v":"Hi [EMA', 'IL_1]"}\n\n');
    });
    const redacted = JSON.stringify({ messages: [{ content: { parts: ['mail [EMAIL_1]'] } }] });
    const { ch, asked, counted } = channel((a) => {
      if (a.op === 'request') {
        return { ok: true, result: { action: 'rewrite', body: toBase64(enc.encode(redacted)), ticket: 't1', redacted: 1 } as Decision };
      }
      // Veil holds back a split placeholder until the next chunk.
      const text = dec.decode(fromBase64(String(a.payload.chunk ?? '')));
      const out = text.replace('Hi [EMA', 'Hi ').replace('IL_1]', 'ana@example.com');
      return { ok: true, result: { chunk: toBase64(enc.encode(out)) } };
    });
    const f = wrapFetch(real as unknown as typeof fetch, 'chatgpt.com', ch, () => BASE);
    const resp = await f('/backend-api/f/conversation', send);
    expect(sent).toBe(redacted);
    expect(sent).not.toContain('ana@example.com');
    expect(counted).toEqual([1]);
    expect(resp.headers.get('content-length')).toBeNull();
    expect(await resp.text()).toBe('data: {"v":"Hi ana@example.com"}\n\n');

    const request = asked[0].payload;
    expect(request.site).toBe('chatgpt.com');
    expect(request.path).toBe('/backend-api/f/conversation');
    expect(dec.decode(fromBase64(String(request.body)))).toBe(send.body);
    const chunks = asked.filter((a) => a.op === 'response').map((a) => a.payload);
    expect(chunks[0].content_type).toBe('text/event-stream');
    expect(chunks[0].status).toBe(200);
    expect(chunks.at(-1)!.done).toBe(true);
    expect(chunks.every((c) => c.ticket === 't1')).toBe(true);
  });

  it('tells Veil about documents attached before a send, and when it went out', async () => {
    const real = vi.fn(async () => new Response('ok'));
    const { ch, asked } = channel(() => ({ ok: true, result: { action: 'pass', redacted: 0 } }));
    const sent = vi.fn();
    ch.attached = () => ({ draft: 'd1', veil_files: 1 });
    ch.sent = sent;
    const f = wrapFetch(real as unknown as typeof fetch, 'chatgpt.com', ch, () => BASE);
    await f('/backend-api/f/conversation', send);
    expect(asked[0].payload).toMatchObject({ draft: 'd1', veil_files: 1 });
    expect(sent).toHaveBeenCalledTimes(1);
    // Reading a chat isn't a send.
    await f('/backend-api/conversation/abc');
    expect(asked[1].payload.draft).toBeUndefined();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('blocks a send that Veil blocks, and says why', async () => {
    const real = vi.fn();
    const { ch, blocked } = channel(() => ({ ok: true, result: { action: 'block', message: 'Veil is paused.', redacted: 0 } }));
    const f = wrapFetch(real as unknown as typeof fetch, 'chatgpt.com', ch, () => BASE);
    const resp = await f('/backend-api/conversation', send);
    expect(resp.status).toBe(403);
    expect(real).not.toHaveBeenCalled();
    expect(blocked).toEqual(['Veil is paused.']);
  });

  it('fails closed when Veil cannot be reached, unless the user allowed it', async () => {
    const real = vi.fn(async () => new Response('sent'));
    const down = () => ({ ok: false, error: 'not_running' }) as Answer;

    const closed = channel(down);
    let f = wrapFetch(real as unknown as typeof fetch, 'chatgpt.com', closed.ch, () => BASE);
    expect((await f('/backend-api/conversation', send)).status).toBe(403);
    expect(real).not.toHaveBeenCalled();
    expect(closed.blocked[0]).toContain("isn't running");

    // Reading a saved chat is still allowed: nothing leaves the browser.
    expect(await (await f('/backend-api/conversation/abc')).text()).toBe('sent');

    const open = channel(down, true);
    f = wrapFetch(real as unknown as typeof fetch, 'chatgpt.com', open.ch, () => BASE);
    expect(await (await f('/backend-api/conversation', send)).text()).toBe('sent');
    expect(open.blocked).toHaveLength(0);
  });

  it('accepts Request objects and keeps their headers', async () => {
    let seen: Request | undefined;
    const real = vi.fn(async (req: Request) => {
      seen = req;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    const { ch } = channel(() => ({ ok: true, result: { action: 'rewrite', body: toBase64(enc.encode('{"prompt":"[EMAIL_1]"}')), redacted: 1 } }));
    const f = wrapFetch(real as unknown as typeof fetch, 'claude.ai', ch, () => 'https://claude.ai/chat/x');
    const req = new Request('https://claude.ai/api/organizations/o/chat_conversations/c/completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-client-platform': 'web_claude_ai' },
      body: '{"prompt":"ana@example.com"}',
    });
    await f(req);
    expect(seen!.headers.get('anthropic-client-platform')).toBe('web_claude_ai');
    expect(await seen!.text()).toBe('{"prompt":"[EMAIL_1]"}');
  });

  it('passes the rest of a reply through if Veil stops answering mid-way', async () => {
    const real = vi.fn(async () => sse('one ', 'two'));
    let calls = 0;
    const { ch } = channel((a) => {
      if (a.op === 'request') return { ok: true, result: { action: 'pass', ticket: 't', redacted: 0 } };
      calls++;
      return calls === 1
        ? { ok: true, result: { chunk: String(a.payload.chunk) } }
        : ({ ok: false, error: 'host_exited' } as Answer);
    });
    const f = wrapFetch(real as unknown as typeof fetch, 'chatgpt.com', ch, () => BASE);
    const resp = await f('/backend-api/conversation', send);
    expect(await resp.text()).toBe('one two');
  });

  it('tells Veil when the reply breaks off', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: one\n\n'));
        c.error(new DOMException('The user aborted a request.', 'AbortError'));
      },
    });
    const real = vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    const { ch, asked } = channel((a) =>
      a.op === 'request'
        ? { ok: true, result: { action: 'pass', ticket: 't', redacted: 0 } }
        : { ok: true, result: { chunk: String(a.payload.chunk ?? '') } },
    );
    const f = wrapFetch(real as unknown as typeof fetch, 'chatgpt.com', ch, () => BASE);
    const resp = await f('/backend-api/conversation', send);
    await expect(resp.text()).rejects.toThrow();
    const last = asked.filter((a) => a.op === 'response').at(-1)!.payload;
    expect(last).toMatchObject({ ticket: 't', done: true, error: 'aborted_by_page' });
  });
});

