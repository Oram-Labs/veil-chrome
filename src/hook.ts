// Runs in the page's own JavaScript world at document_start, before the
// site's scripts, so the site only ever sees the wrapped `fetch`.
//
// It talks to the content bridge over a private MessageChannel. The port is
// handed over in the first message of the page load, before any site script
// exists, and the bridge accepts only that first one.

import { catchFiles } from './catch';
import { Documents, guardFetch, guardXhr, type Notices } from './documents';
import { wrapFetch, type Channel } from './intercept';
import { gated, observeFetch, observePage } from './observe';
import { hookPageData } from './pagedata';
import { siteOf, type Answer, type Op, type VeilStatus } from './protocol';
import { interesting } from './sites';

(() => {
  const site = siteOf(location.hostname);
  if (!site || (window as unknown as Record<string, unknown>).__veilHooked) return;
  Object.defineProperty(window, '__veilHooked', { value: true });

  const { port1, port2 } = new MessageChannel();
  let next = 1;
  const waiting = new Map<number, (value: unknown) => void>();
  port1.onmessage = (event: MessageEvent) => {
    const { id, value } = event.data ?? {};
    const resolve = waiting.get(id);
    if (resolve) {
      waiting.delete(id);
      resolve(value);
    }
  };
  const call = <T>(kind: string, body: Record<string, unknown> = {}, ms = 60_000): Promise<T | undefined> =>
    new Promise((resolve) => {
      const id = next++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(undefined);
      }, ms);
      waiting.set(id, (value) => {
        clearTimeout(timer);
        resolve(value as T);
      });
      port1.postMessage({ id, kind, ...body });
    });
  window.postMessage({ __veil: 'hello' }, location.origin, [port2]);

  const channel: Channel = {
    async ask<T>(op: Op, payload: unknown): Promise<Answer<T>> {
      const answer = await call<Answer<T>>('ask', { op, payload });
      return answer ?? { ok: false, error: 'timeout' };
    },
    async allowUnprotected() {
      return (await call<boolean>('prefs', {}, 5_000)) === true;
    },
    blocked(message) {
      port1.postMessage({ id: 0, kind: 'blocked', message });
    },
    counted(n) {
      port1.postMessage({ id: 0, kind: 'counted', n });
    },
    attached: () => docs.context(),
    sent: () => docs.sent(),
  };
  const notices: Notices = {
    info: (message) => port1.postMessage({ id: 0, kind: 'notice', message }),
    blocked: (message) => channel.blocked(message),
  };

  const status = channel.ask<VeilStatus>('status', undefined);
  // Documents the user attaches go to Veil first; see documents.ts.
  const docs = new Documents(site, channel, notices, status.then((a) => (a.ok ? a.result.documents : undefined)));
  // How each document reached the page goes into the capture, so a site
  // that ignores Veil's file can be seen.
  catchFiles(window, docs, (how, detail) => report({ site, kind: 'veil_document', detail: { how, ...detail } }));
  // XHR can't wait for the answer, so it uses the last one.
  let unprotected = false;
  const allow = async () => (unprotected = await channel.allowUnprotected());
  void allow();
  guardXhr(XMLHttpRequest.prototype, docs, notices, () => {
    void allow();
    return unprotected;
  });

  // On a reload chatgpt.com puts the open chat in the HTML; restore it
  // before the page reads it. A chunk Veil doesn't answer in time is kept.
  if (site === 'chatgpt.com') {
    hookPageData(window, async (text, conversation) => {
      const answer = await Promise.race([
        channel.ask<{ text: string }>('page_data', { site, conversation, text }),
        new Promise<Answer<{ text: string }>>((r) => setTimeout(() => r({ ok: false, error: 'timeout' }), 5_000)),
      ]);
      return answer.ok ? answer.result.text : null;
    });
  }

  // With "Capture traffic" on in Veil, everything the page does on the site
  // is reported too, for debugging. Until Veil answers, reports are held.
  const capture = status.then((a) => a.ok && a.result.capture === true);
  const report = gated((observation) => void channel.ask('observe', observation), capture);
  observePage(site, report);

  const realFetch = window.fetch.bind(window);
  const wrapped = guardFetch(
    observeFetch(wrapFetch(realFetch, site, channel), site, report, (method, path) =>
      interesting(site, method, path.split('?')[0]),
    ),
    docs,
    notices,
    allow,
  );
  // Keep the name and `toString()` looking native; some sites check.
  Object.defineProperty(wrapped, 'name', { value: 'fetch' });
  Object.defineProperty(wrapped, 'toString', { value: () => 'function fetch() { [native code] }' });
  window.fetch = wrapped;
})();
