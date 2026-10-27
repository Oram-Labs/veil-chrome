// Content script in the extension's own world. It takes the hook's port,
// passes its questions to the service worker, and shows a banner when a
// message or file was stopped, or a document was read.

import { DEFAULT_PREFS, siteOf, type Answer, type Prefs } from './protocol';

const site = siteOf(location.hostname);
let accepted = false;

window.addEventListener('message', (event: MessageEvent) => {
  if (accepted || event.source !== window || event.data?.__veil !== 'hello' || !event.ports[0]) return;
  accepted = true;
  const port = event.ports[0];
  port.onmessage = (e: MessageEvent) => void handle(port, e.data ?? {});
});

async function handle(port: MessagePort, msg: Record<string, unknown>): Promise<void> {
  switch (msg.kind) {
    case 'ask': {
      let value: Answer;
      try {
        value = await chrome.runtime.sendMessage({ op: msg.op, payload: msg.payload });
      } catch {
        // The extension was updated or turned off since the page loaded.
        value = { ok: false, error: 'no_extension' };
      }
      port.postMessage({ id: msg.id, value: value ?? { ok: false, error: 'no_answer' } });
      return;
    }
    case 'prefs': {
      const prefs = await readPrefs();
      port.postMessage({ id: msg.id, value: site ? prefs.unprotected[site] === true : false });
      return;
    }
    case 'blocked':
      showBanner(String(msg.message ?? 'Veil stopped this message.'), 'error');
      return;
    case 'notice':
      showBanner(String(msg.message ?? ''), 'info');
      return;
    case 'counted':
      try {
        await chrome.runtime.sendMessage({ op: 'count', payload: { n: msg.n } });
      } catch {
        // Counting is best effort.
      }
      return;
  }
}

async function readPrefs(): Promise<Prefs> {
  try {
    const stored = await chrome.storage.local.get('prefs');
    return { ...DEFAULT_PREFS, ...(stored.prefs as Prefs | undefined) };
  } catch {
    return DEFAULT_PREFS;
  }
}

let banner: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function showBanner(message: string, tone: 'error' | 'info'): void {
  if (!banner) {
    banner = document.createElement('veil-banner');
    const shadow = banner.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .box { position: fixed; z-index: 2147483647; left: 50%; top: 16px; transform: translateX(-50%);
          max-width: min(560px, calc(100vw - 32px)); box-sizing: border-box; display: flex; gap: 12px; align-items: flex-start;
          padding: 12px 14px; border-radius: 10px; background: #fbe9e7; color: #9b1c13; border: 1px solid #f0c4bf;
          font: 14px/1.45 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.15); }
        @media (prefers-color-scheme: dark) { .box { background: #3a1714; color: #ffd9d4; border-color: #6b2a24; } }
        .box.info { background: #f2f3f5; color: #35373e; border-color: #d9dbe0; }
        @media (prefers-color-scheme: dark) { .box.info { background: #2a2c31; color: #e6e7ea; border-color: #44464d; } }
        strong { font-weight: 600; }
        button { all: unset; cursor: pointer; padding: 0 4px; font-size: 18px; line-height: 1; opacity: .7; }
        button:hover, button:focus-visible { opacity: 1; outline: 2px solid currentColor; border-radius: 4px; }
      </style>
      <div class="box" role="alert"><div><strong>Veil</strong> · <span class="text"></span></div><button aria-label="Dismiss">×</button></div>`;
    shadow.querySelector('button')!.addEventListener('click', () => banner?.remove());
    (banner as HTMLElement & { _text?: Element })._text = shadow.querySelector('.text')!;
    (banner as HTMLElement & { _box?: Element })._box = shadow.querySelector('.box')!;
  }
  (banner as HTMLElement & { _text?: Element })._text!.textContent = message;
  const box = (banner as HTMLElement & { _box?: Element })._box!;
  box.classList.toggle('info', tone === 'info');
  box.setAttribute('role', tone === 'info' ? 'status' : 'alert');
  if (!banner.isConnected) document.documentElement.appendChild(banner);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => banner?.remove(), tone === 'info' ? 6_000 : 15_000);
}
