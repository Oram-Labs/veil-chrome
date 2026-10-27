import { describe, expect, it, vi } from 'vitest';
import { Documents, guardFetch, isDocument, type Notices } from '../src/documents';
import type { Channel } from '../src/intercept';
import { fromBase64, type Answer, type DocumentsView, type Op } from '../src/protocol';

const VIEW: DocumentsView = {
  enabled: true,
  max_mb: 1,
  formats: [{ id: 'pdf', name: 'PDF', extensions: ['pdf'], mime_types: ['application/pdf'] }],
};

interface Asked {
  op: Op;
  payload: Record<string, unknown>;
}

function setup(answer: (a: Asked) => Answer, opts: { unprotected?: boolean; view?: DocumentsView } = {}) {
  const asked: Asked[] = [];
  const counted: number[] = [];
  const info: string[] = [];
  const blocked: string[] = [];
  const channel: Channel = {
    async ask<T>(op: Op, payload: unknown) {
      const a = { op, payload: payload as Record<string, unknown> };
      asked.push(a);
      return answer(a) as Answer<T>;
    },
    allowUnprotected: async () => opts.unprotected ?? false,
    blocked: (m) => blocked.push(m),
    counted: (n) => counted.push(n),
  };
  const notices: Notices = { info: (m) => info.push(m), blocked: (m) => blocked.push(m) };
  let path = '/new';
  const docs = new Documents('claude.ai', channel, notices, Promise.resolve(opts.view ?? VIEW), () => path);
  return { docs, asked, counted, info, blocked, notices, go: (p: string) => (path = p) };
}

const pdf = (name = 'report.pdf') => new File(['%PDF-1.7 hello'], name, { type: 'application/pdf' });
const replace = (text = 'redacted text'): Answer => ({
  ok: true,
  result: { action: 'replace', name: 'report (redacted).md', mime: 'text/markdown', text, redacted: 2, pages: 1 },
});

describe('isDocument', () => {
  it('goes by the extension or the type Veil lists', () => {
    expect(isDocument(pdf(), VIEW)).toBe(true);
    expect(isDocument(new File(['x'], 'SCAN.PDF'), VIEW)).toBe(true);
    expect(isDocument(new File(['x'], 'noext', { type: 'application/pdf' }), VIEW)).toBe(true);
    expect(isDocument(new File(['x'], 'photo.png', { type: 'image/png' }), VIEW)).toBe(false);
    expect(isDocument(new Blob(['x'], { type: 'application/pdf' }), VIEW)).toBe(true);
  });

  it('knows new types from Veil alone', () => {
    const view = { ...VIEW, formats: [...VIEW.formats, { id: 'docx', name: 'Word', extensions: ['docx'], mime_types: [] }] };
    expect(isDocument(new File(['x'], 'cv.docx'), view)).toBe(true);
  });
});

describe('Documents', () => {
  it('swaps a document for Veil\'s text file and keeps other files', async () => {
    const { docs, asked, counted, info } = setup(() => replace());
    const photo = new File(['png'], 'photo.png', { type: 'image/png' });
    const out = await docs.transform([pdf(), photo]);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('report (redacted).md');
    expect(out[0].type).toBe('text/markdown');
    expect(await out[0].text()).toBe('redacted text');
    expect(out[1]).toBe(photo);
    const sent = asked.find((a) => a.op === 'document')!.payload;
    expect(sent).toMatchObject({ site: 'claude.ai', page: '/new', name: 'report.pdf' });
    expect(new TextDecoder().decode(fromBase64(sent.data as string))).toBe('%PDF-1.7 hello');
    expect(typeof sent.draft).toBe('string');
    expect(counted).toEqual([2]);
    expect(info.at(-1)).toContain('2 values hidden');
    // Veil's file isn't sent to Veil again.
    expect(docs.wants(out)).toBe(false);
  });

  it('sends only the size of a file larger than Veil reads', async () => {
    const { docs, asked } = setup(() => ({ ok: true, result: { action: 'block', message: 'too big', redacted: 0, pages: 0 } }));
    const big = new File([new Uint8Array(2 * 1024 * 1024)], 'big.pdf');
    expect(await docs.transform([big])).toEqual([]);
    const sent = asked.find((a) => a.op === 'document')!.payload;
    expect(sent.data).toBeUndefined();
    expect(sent.size).toBe(2 * 1024 * 1024);
  });

  it('leaves the document out when Veil blocks it or can\'t be reached', async () => {
    const block = setup(() => ({ ok: true, result: { action: 'block', message: 'Scanned.', redacted: 0, pages: 0 } }));
    expect(await block.docs.transform([pdf()])).toEqual([]);
    expect(block.blocked).toEqual(['Scanned.']);

    const down = setup(() => ({ ok: false, error: 'not_running' }));
    expect(await down.docs.transform([pdf()])).toEqual([]);
    expect(down.blocked[0]).toContain('report.pdf was not attached');

    const allowed = setup(() => ({ ok: false, error: 'not_running' }), { unprotected: true });
    const file = pdf();
    expect(await allowed.docs.transform([file])).toEqual([file]);
  });

  it('keeps the original when Veil passes it', async () => {
    const { docs } = setup(() => ({ ok: true, result: { action: 'pass', redacted: 0, pages: 0 } }));
    const file = pdf();
    expect(await docs.transform([file])).toEqual([file]);
    expect(docs.inspect(file)).toBeNull();
  });

  it('tells the next send about its draft and Veil\'s uploads, until the address changes', async () => {
    const { docs, go } = setup(() => replace());
    expect(docs.context()).toEqual({});
    const [made] = await docs.transform([pdf()]);
    const draft = docs.context().draft;
    expect(draft).toMatch(/^[0-9a-f]{32}$/);

    const form = new FormData();
    form.append('file', made);
    expect(docs.inspect(form)).toBeNull();
    expect(docs.inspect(made)).toBeNull(); // the same file twice counts once
    expect(docs.context()).toEqual({ draft, veil_files: 1 });
    docs.sent();
    expect(docs.context()).toEqual({ draft });

    go('/chat/abc');
    expect(docs.context()).toEqual({});
  });

  it('refuses to upload a document Veil hasn\'t seen', async () => {
    const { docs, notices, blocked } = setup(() => replace());
    const inner = vi.fn(async () => new Response('ok'));
    const f = guardFetch(inner as typeof fetch, docs, notices, async () => false);
    const form = new FormData();
    form.append('file', pdf('secret.pdf'));
    await expect(f('/upload', { method: 'POST', body: form })).rejects.toThrow();
    expect(inner).not.toHaveBeenCalled();
    expect(blocked[0]).toContain('secret.pdf');

    await f('/upload', { method: 'POST', body: new File(['png'], 'a.png', { type: 'image/png' }) });
    await f('/api', { method: 'POST', body: '{"a":1}' });
    expect(inner).toHaveBeenCalledTimes(2);

    const open = guardFetch(inner as typeof fetch, docs, notices, async () => true);
    await open('/upload', { method: 'POST', body: form });
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it('asks Veil for its types again if it wasn\'t running at page load', async () => {
    const asked: string[] = [];
    const channel: Channel = {
      async ask<T>(op: Op) {
        asked.push(op);
        if (op === 'status') return { ok: true, result: { documents: VIEW } } as Answer<T>;
        return replace() as Answer<T>;
      },
      allowUnprotected: async () => false,
      blocked: () => {},
      counted: () => {},
    };
    const docs = new Documents('chatgpt.com', channel, { info: () => {}, blocked: () => {} }, Promise.resolve(undefined), () => '/');
    // Until then, PDFs are still caught.
    expect(docs.wants([pdf()])).toBe(true);
    await docs.transform([pdf()]);
    expect(asked).toEqual(['status', 'document']);
  });
});
