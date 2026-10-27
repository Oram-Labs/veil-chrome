// While "Capture traffic" is on in Veil, report what the page does on the
// chat site, so a change in how the site loads or streams chats can be seen
// instead of guessed: every fetch and XHR, WebSocket and EventSource traffic,
// address changes, and the data built into the page itself (what a full
// reload shows before any request is made).
//
// Veil writes each report to its capture folder. Nothing is reported while
// capture is off. Reports made before Veil has answered are held, then sent
// or dropped.

import type { Site } from './protocol';

export type Report = ((observation: Observation) => void) & {
  /** True once Veil said capture is off: skip the work of reporting. */
  off?: () => boolean;
};

export interface Observation {
  site: Site;
  kind: string;
  method?: string;
  path?: string;
  status?: number;
  detail: Record<string, unknown>;
}

/** Request and reply bodies kept per request. */
const BODY_CAP = 256 * 1024;
/** Text built into the page, kept per load. */
const PAGE_CAP = 4 * 1024 * 1024;
/** WebSocket messages kept per socket, and bytes per message. */
const WS_MESSAGES = 300;
const WS_CAP = 16 * 1024;

const STATIC = /\.(js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp3|mp4|webm|wasm)$/i;
const TEXTUAL = /json|text|javascript|event-stream|xml|x-www-form-urlencoded|proto/i;

/** Holds reports until `enabled` settles: sent if capture is on, else dropped. */
export function gated(send: Report, enabled: Promise<boolean>): Report {
  let state: 'waiting' | 'on' | 'off' = 'waiting';
  const held: Observation[] = [];
  void enabled.then(
    (on) => {
      state = on ? 'on' : 'off';
      if (on) held.splice(0).forEach(send);
      else held.length = 0;
    },
    () => {
      state = 'off';
      held.length = 0;
    },
  );
  const report: Report = (observation) => {
    if (state === 'on') send(observation);
    else if (state === 'waiting' && held.length < 2000) held.push(observation);
  };
  report.off = () => state === 'off';
  return report;
}

function clip(text: string, cap: number): { text: string; truncated?: number } {
  return text.length > cap ? { text: text.slice(0, cap), truncated: text.length } : { text };
}

async function bodyText(body: BodyInit | null | undefined): Promise<Record<string, unknown> | undefined> {
  if (body == null) return undefined;
  if (typeof body === 'string') return clip(body, BODY_CAP);
  if (body instanceof URLSearchParams) return clip(body.toString(), BODY_CAP);
  if (body instanceof Blob) return { blob: body.type, size: body.size };
  if (body instanceof FormData) return { form_fields: [...body.keys()] };
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { ...clip(new TextDecoder().decode(bytes.subarray(0, BODY_CAP)), BODY_CAP), bytes: bytes.length };
  }
  return { kind: Object.prototype.toString.call(body) };
}

/** Up to BODY_CAP of a reply, read from a copy so the page's own read is untouched. */
async function replyText(response: Response): Promise<Record<string, unknown> | undefined> {
  const type = response.headers.get('content-type') ?? '';
  if (!response.body || !TEXTUAL.test(type)) return undefined;
  const reader = response.clone().body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (text.length < BODY_CAP) text += decoder.decode(value, { stream: true });
      if (text.length >= BODY_CAP) {
        await reader.cancel();
        return { ...clip(text, BODY_CAP), stopped_reading_at: total };
      }
    }
  } catch (error) {
    return { ...clip(text, BODY_CAP), broke_off: String(error) };
  }
  return clip(text, BODY_CAP);
}

function where(url: string | URL, base: string): { host: string; path: string } | null {
  try {
    const u = new URL(String(url), base);
    return { host: u.host, path: u.pathname + u.search };
  } catch {
    return null;
  }
}

/**
 * Wraps `fetch` so each call is reported. `handled` says whether the
 * extension sent it through Veil (Veil captures those in full itself).
 */
export function observeFetch(
  inner: typeof fetch,
  site: Site,
  report: Report,
  handled: (method: string, path: string) => boolean,
  base: () => string = () => location.href,
): typeof fetch {
  return async function fetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (report.off?.()) return inner.call(this, input, init);
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const method = (init?.method ?? (isRequest ? (input as Request).method : 'GET')).toUpperCase();
    const at = where(isRequest ? (input as Request).url : (input as string | URL), base());
    const skip = !at || STATIC.test(at.path.split('?')[0]);
    const sameSite = !!at && at.host === new URL(base()).host;
    const veil = !!at && sameSite && handled(method, at.path);
    const started = Date.now();
    let request: Record<string, unknown> | undefined;
    if (!skip && sameSite && !veil) {
      request = await bodyText(init?.body ?? (isRequest ? await (input as Request).clone().text().catch(() => undefined) : undefined));
    }
    let response: Response;
    try {
      response = await inner.call(this, input, init);
    } catch (error) {
      if (!skip) {
        report({ site, kind: 'fetch', method, path: at!.path, detail: { host: at!.host, request, failed: String(error), via_veil: veil } });
      }
      throw error;
    }
    if (!skip) {
      const status = response.status;
      const detail: Record<string, unknown> = {
        host: at!.host,
        via_veil: veil,
        content_type: response.headers.get('content-type'),
        ms: Date.now() - started,
        request,
      };
      if (sameSite && !veil) {
        void replyText(response).then((reply) => report({ site, kind: 'fetch', method, path: at!.path, status, detail: { ...detail, response: reply } }));
      } else {
        report({ site, kind: 'fetch', method, path: at!.path, status, detail });
      }
    }
    return response;
  };
}

/** XMLHttpRequest, WebSocket, EventSource, address changes and the page itself. */
export function observePage(site: Site, report: Report): void {
  const base = () => location.href;

  const XHR = XMLHttpRequest.prototype;
  const open = XHR.open;
  const send = XHR.send;
  XHR.open = function (this: XMLHttpRequest & { __veil?: Record<string, unknown> }, method: string, url: string | URL, ...rest: unknown[]) {
    this.__veil = { method: method.toUpperCase(), at: where(url, base()) };
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XHR.open;
  XHR.send = function (this: XMLHttpRequest & { __veil?: Record<string, unknown> }, body?: Document | XMLHttpRequestBodyInit | null) {
    const note = this.__veil;
    const at = note?.at as { host: string; path: string } | null;
    if (at && !report.off?.() && !STATIC.test(at.path.split('?')[0])) {
      const started = Date.now();
      this.addEventListener('loadend', () => {
        const textual = this.responseType === '' || this.responseType === 'text';
        void bodyText(body as BodyInit).then((request) =>
          report({
            site,
            kind: 'xhr',
            method: note!.method as string,
            path: at.path,
            status: this.status,
            detail: {
              host: at.host,
              content_type: this.getResponseHeader('content-type'),
              ms: Date.now() - started,
              request,
              response: textual ? clip(this.responseText ?? '', BODY_CAP) : { response_type: this.responseType },
            },
          }),
        );
      });
    }
    return send.call(this, body);
  };

  const NativeSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const socket = new target(...args);
      const at = where(args[0], base());
      let count = 0;
      const message = (direction: string, data: unknown) => {
        if (count++ >= WS_MESSAGES) return;
        const text = typeof data === 'string' ? clip(data, WS_CAP) : { binary: (data as Blob | ArrayBuffer)?.constructor?.name };
        report({ site, kind: 'websocket', method: direction, path: at?.path, detail: { host: at?.host, n: count, ...text } });
      };
      report({ site, kind: 'websocket', method: 'OPEN', path: at?.path, detail: { host: at?.host, protocols: args[1] } });
      socket.addEventListener('message', (e) => message('RECV', e.data));
      socket.addEventListener('close', (e) => report({ site, kind: 'websocket', method: 'CLOSE', path: at?.path, detail: { code: e.code } }));
      const realSend = socket.send.bind(socket);
      socket.send = (data) => {
        message('SEND', data);
        realSend(data);
      };
      return socket;
    },
  });

  if (typeof EventSource !== 'undefined') {
    const NativeSource = window.EventSource;
    window.EventSource = new Proxy(NativeSource, {
      construct(target, args: [string | URL, EventSourceInit?]) {
        const at = where(args[0], base());
        report({ site, kind: 'eventsource', method: 'OPEN', path: at?.path, detail: { host: at?.host } });
        return new target(...args);
      },
    });
  }

  for (const name of ['pushState', 'replaceState'] as const) {
    const real = history[name];
    history[name] = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
      const result = real.call(this, data, unused, url);
      report({ site, kind: 'navigation', method: name, path: location.pathname + location.search, detail: {} });
      return result;
    };
  }
  window.addEventListener('popstate', () =>
    report({ site, kind: 'navigation', method: 'popstate', path: location.pathname + location.search, detail: {} }),
  );

  // On a full reload the chat may be inside the HTML rather than fetched.
  const page = () => {
    const scripts = [...document.querySelectorAll('script:not([src])')].map((s) => s.textContent ?? '');
    const text = scripts.join('\n/* ---- next inline script ---- */\n');
    report({
      site,
      kind: 'document',
      method: 'LOAD',
      path: location.pathname + location.search,
      detail: {
        inline_scripts: scripts.length,
        service_worker: !!navigator.serviceWorker?.controller,
        scripts: clip(text, PAGE_CAP),
      },
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', page, { once: true });
  else page();
}
