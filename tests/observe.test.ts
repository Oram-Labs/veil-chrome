import { describe, expect, it, vi } from 'vitest';
import { gated, observeFetch, type Observation } from '../src/observe';

const BASE = 'https://chatgpt.com/c/1';

describe('gated', () => {
  it('holds reports until Veil answers, then sends them or drops them', async () => {
    let open!: (on: boolean) => void;
    const sent: Observation[] = [];
    const report = gated((o) => sent.push(o), new Promise((r) => (open = r)));
    report({ site: 'chatgpt.com', kind: 'document', detail: {} });
    expect(sent).toHaveLength(0);
    open(true);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    report({ site: 'chatgpt.com', kind: 'fetch', detail: {} });
    expect(sent).toHaveLength(2);

    const dropped: Observation[] = [];
    const off = gated((o) => dropped.push(o), Promise.resolve(false));
    off({ site: 'chatgpt.com', kind: 'document', detail: {} });
    await Promise.resolve();
    expect(dropped).toHaveLength(0);
    expect(off.off?.()).toBe(true);
  });
});

describe('observeFetch', () => {
  it('reports requests with their bodies, skipping static files', async () => {
    const seen: Observation[] = [];
    const report = gated((o) => seen.push(o), Promise.resolve(true));
    await Promise.resolve();
    const inner = vi.fn(async () => new Response('{"items":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const f = observeFetch(inner as typeof fetch, 'chatgpt.com', report, (_m, p) => p.startsWith('/backend-api/f/'), () => BASE);
    await f('/backend-api/f/conversation/resume', { method: 'POST', body: '{"token":"t"}' });
    await f('/assets/app.js');
    await f('/backend-api/f/conversation', { method: 'POST', body: '{"x":1}' });
    await new Promise((r) => setTimeout(r, 10));
    expect(inner).toHaveBeenCalledTimes(3);
    const resume = seen.find((o) => o.path === '/backend-api/f/conversation/resume');
    expect(resume?.status).toBe(200);
    expect(resume?.detail.via_veil).toBe(true);
    expect(seen.some((o) => o.path === '/assets/app.js')).toBe(false);
  });

  it('keeps bodies of requests Veil does not handle', async () => {
    const seen: Observation[] = [];
    const report = gated((o) => seen.push(o), Promise.resolve(true));
    await Promise.resolve();
    const inner = vi.fn(async () => new Response('data: hi\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const f = observeFetch(inner as typeof fetch, 'chatgpt.com', report, () => false, () => BASE);
    await f('/backend-api/f/conversation/resume', { method: 'POST', body: '{"token":"t"}' });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen[0].detail.request).toEqual({ text: '{"token":"t"}' });
    expect(seen[0].detail.response).toEqual({ text: 'data: hi\n\n' });
  });

  it('does nothing extra when capture is off', async () => {
    const send = vi.fn();
    const report = gated(send, Promise.resolve(false));
    await Promise.resolve();
    const inner = vi.fn(async () => new Response('ok'));
    const f = observeFetch(inner as typeof fetch, 'chatgpt.com', report, () => false, () => BASE);
    await f('/backend-api/me');
    expect(send).not.toHaveBeenCalled();
  });
});
