#!/usr/bin/env node
// A stand-in for the Veil app, as Chrome's native messaging host, so the
// end-to-end tests run without it. It speaks the protocol in PROTOCOL.md and
// does a simple version of what the app does: email addresses and phone
// numbers become [EMAIL_n] and [PHONE_n] before a request leaves, and come
// back in replies and in chat data built into the page.
//
// Chrome starts one host per connection and may start another later, so the
// mapping lives in a file. Settings, from the environment:
//   MOCK_HOST_DIR   folder for its state and its log (required)
// and files in that folder, which a test can create or remove at any time:
//   stopped         answer every message as the host does when Veil isn't
//                   running ({"ok": false, "error": "not_running"})
//   log.jsonl       written by the host: one line per message it received

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.MOCK_HOST_DIR;
if (!dir) {
  process.stderr.write('MOCK_HOST_DIR is not set\n');
  process.exit(1);
}
const STATE = join(dir, 'state.json');
const VALUES = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['PHONE', /\+\d{1,3}(?: \d{2,4}){2,4}/g],
];
const PLACEHOLDER = /\[([A-Z]+)_(\d+)\]/g;

function load() {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { byValue: {}, byPlaceholder: {}, next: {}, tickets: {} };
}
function save(state) {
  writeFileSync(STATE, JSON.stringify(state));
}

function redact(state, text) {
  let count = 0;
  for (const [kind, re] of VALUES) {
    text = text.replace(re, (value) => {
      count++;
      if (!state.byValue[value]) {
        state.next[kind] = (state.next[kind] ?? 0) + 1;
        const ph = `[${kind}_${state.next[kind]}]`;
        state.byValue[value] = ph;
        state.byPlaceholder[ph] = value;
      }
      return state.byValue[value];
    });
  }
  return { text, count };
}

function restore(state, text) {
  let count = 0;
  const out = text.replace(PLACEHOLDER, (ph) => {
    const value = state.byPlaceholder[ph];
    if (value === undefined) return ph;
    count++;
    return value;
  });
  return { text: out, count };
}

/** Where to stop releasing streamed text: before a tail that could still become a placeholder. */
function holdFrom(text) {
  const open = text.lastIndexOf('[');
  if (open < 0 || text.indexOf(']', open) >= 0) return text.length;
  return /^\[[A-Z]*_?\d*$/.test(text.slice(open)) ? open : text.length;
}

/** How many leading bytes of `bytes` are whole UTF-8 characters. */
function completeUtf8(bytes) {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const b = bytes[bytes.length - back];
    if ((b & 0xc0) === 0x80) continue; // a continuation byte: look further back
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const unb64 = (text) => Buffer.from(text ?? '', 'base64').toString('utf8');

function answer(message) {
  const { id, op, payload = {} } = message;
  if (existsSync(join(dir, 'stopped'))) return { id, ok: false, error: 'not_running' };
  const state = load();
  const ok = (result) => {
    save(state);
    return { id, ok: true, result };
  };
  switch (op) {
    case 'ping':
      return ok({ host: 'mock' });
    case 'status':
      return ok({
        version: 'mock',
        running: true,
        activated: true,
        mode: 'redact',
        fail_closed: true,
        sites: { 'claude.ai': true, 'chatgpt.com': true },
        capture: false,
      });
    case 'request': {
      if (!payload.body) return ok({ action: 'pass', redacted: 0 });
      const { text, count } = redact(state, unb64(payload.body));
      const ticket = `t${Object.keys(state.tickets).length + 1}-${Date.now()}`;
      state.tickets[ticket] = '';
      return ok({ action: 'rewrite', body: b64(text), ticket, redacted: count });
    }
    case 'response': {
      // Bytes held from earlier chunks, then this one. A chunk can end inside
      // a character or a placeholder; both wait for the next chunk.
      const bytes = Buffer.concat([Buffer.from(state.tickets[payload.ticket] ?? '', 'base64'), Buffer.from(payload.chunk ?? '', 'base64')]);
      const whole = payload.done ? bytes.length : completeUtf8(bytes);
      const text = bytes.subarray(0, whole).toString('utf8');
      const cut = payload.done ? text.length : holdFrom(text);
      const rest = Buffer.concat([Buffer.from(text.slice(cut), 'utf8'), bytes.subarray(whole)]);
      if (payload.done) delete state.tickets[payload.ticket];
      else state.tickets[payload.ticket] = rest.toString('base64');
      return ok({ chunk: b64(restore(state, text.slice(0, cut)).text) });
    }
    case 'observe':
      return ok({ written: false });
    case 'page_data': {
      const { text, count } = restore(state, payload.text ?? '');
      return ok({ text, restored: count });
    }
    default:
      return { id, ok: false, error: 'unknown_op' };
  }
}

// Native messaging: each message is a 4-byte length in native byte order
// (little-endian on the machines Chrome runs on), then that much JSON.
let buffer = Buffer.alloc(0);
process.stdin.on('data', (data) => {
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) return;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
    buffer = buffer.subarray(4 + length);
    appendFileSync(join(dir, 'log.jsonl'), JSON.stringify({ op: message.op, payload: message.payload ?? null }) + '\n');
    const reply = Buffer.from(JSON.stringify(answer(message)), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(reply.length, 0);
    process.stdout.write(Buffer.concat([head, reply]));
  }
});
process.stdin.on('end', () => process.exit(0));
