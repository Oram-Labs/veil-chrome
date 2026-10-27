// Stand-ins for claude.ai and chatgpt.com: the same request paths and
// reply formats, a page with a text box, and a log of what "the site"
// received. Chromium reaches them through --host-resolver-rules.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { join } from 'node:path';

/** The chat the stand-in chatgpt.com creates on the first send. */
export const CHAT_ID = '6ad5c530-6c88-83ed-b5fb-0f8a118fe7ff';

/**
 * A reload of that chat, as chatgpt.com serves it: the chat is in the HTML,
 * passed to React Router's stream by inline scripts, with the placeholders
 * the site stored. Here a plain script reads the stream into #ssr.
 */
const reloaded = (stored: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>chatgpt.com chat</title></head>
<body><pre id="ssr"></pre>
<script>window.__reactRouterContext = {"ssr":true};window.__reactRouterContext.stream = new ReadableStream({start(controller){window.__reactRouterContext.streamController = controller;}}).pipeThrough(new TextEncoderStream());</script>
<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(JSON.stringify(['parts', [stored]]))});</script>
<script>window.__reactRouterContext.streamController.close();</script>
<script>
  (async () => {
    const reader = window.__reactRouterContext.stream.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    for (;;) { const { value, done } = await reader.read(); if (done) break; text += value; }
    document.getElementById('ssr').textContent = JSON.parse(text)[1][0];
  })();
</script>
</body></html>`;

export interface Received {
  host: string;
  path: string;
  body: string;
}

const page = (site: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${site}</title></head>
<body>
  <textarea id="box"></textarea>
  <button id="send">Send</button>
  <pre id="reply"></pre>
  <pre id="status"></pre>
  <script>
    const site = ${JSON.stringify(site)};
    document.getElementById('send').onclick = async () => {
      const text = document.getElementById('box').value;
      const reply = document.getElementById('reply');
      const status = document.getElementById('status');
      reply.textContent = '';
      const [path, body] = site === 'chatgpt.com'
        ? ['/backend-api/f/conversation', { action: 'next', model: 'auto', parent_message_id: 'root',
            messages: [{ id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: [text] } }] }]
        : ['/api/organizations/org/chat_conversations/11111111-2222-4333-8444-555555555555/completion',
            { prompt: text, parent_message_uuid: '00000000-0000-4000-8000-000000000000', files: [] }];
      let resp;
      try {
        resp = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      } catch (e) {
        status.textContent = 'error ' + e;
        return;
      }
      status.textContent = 'status ' + resp.status;
      if (!resp.ok) return;
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\\n\\n')) >= 0) {
          const event = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = event.split('\\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\\n');
          if (!data || data === '[DONE]') continue;
          const v = JSON.parse(data);
          if (site === 'chatgpt.com') {
            const add = (op) => { if (op.o === 'append' && op.p === '/message/content/parts/0') reply.textContent += op.v; };
            if (v.o === 'patch') v.v.forEach(add);
            else if (typeof v.v === 'string') add({ p: v.p ?? '/message/content/parts/0', o: v.o ?? 'append', v: v.v });
          } else if (v.type === 'content_block_delta') {
            reply.textContent += v.delta.text;
          }
        }
      }
      status.textContent += ' done';
    };
  </script>
</body></html>`;

/** The site's answer: it repeats what it received, split at awkward places. */
function reply(site: string, said: string): string[] {
  const text = `You said: ${said}`;
  const cut = [0, 7, Math.max(8, text.length - 9), text.length];
  const pieces = cut.slice(1).map((end, i) => text.slice(cut[i], end)).filter(Boolean);
  if (site === 'chatgpt.com') {
    return [
      'event: delta_encoding\ndata: "v1"\n\n',
      `event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: { message: { content: { content_type: 'text', parts: [''] } }, conversation_id: CHAT_ID } })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: pieces[0] })}\n\n`,
      ...pieces.slice(1).map((v) => `event: delta\ndata: ${JSON.stringify({ v })}\n\n`),
      'data: [DONE]\n\n',
    ];
  }
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', content: [] } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    ...pieces.map(
      (t) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`,
    ),
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
}

export function selfSignedCert(dir: string): { key: Buffer; cert: Buffer } {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:claude.ai,DNS:chatgpt.com', '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

export async function startSites(tls: { key: Buffer; cert: Buffer }): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer(tls, (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const site = host === 'chatgpt.com' ? 'chatgpt.com' : 'claude.ai';
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        if (site === 'chatgpt.com' && req.url?.startsWith(`/c/${CHAT_ID}`)) {
          // What the site stored from the last send: the redacted text.
          const last = [...received].reverse().find((r) => r.host === 'chatgpt.com');
          const stored = last ? JSON.parse(last.body).messages[0].content.parts[0] : '';
          res.end(reloaded(stored));
          return;
        }
        res.end(page(site));
        return;
      }
      received.push({ host, path: req.url ?? '', body });
      const json = JSON.parse(body);
      const said = site === 'chatgpt.com' ? json.messages[0].content.parts[0] : json.prompt;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      for (const event of reply(site, said)) {
        res.write(event);
        await new Promise((r) => setTimeout(r, 15));
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { server, port, received };
}
