// Service worker: relays the pages' questions to Veil, and keeps the count of
// values hidden in each tab for the toolbar badge.
//
// Veil is the app, over native messaging, whenever it can be reached. When it
// can't, the extension's built-in engine answers, unless the person turned it
// off in the extension's settings (router.ts).

import { LocalEngine, type Store } from './local/engine';
import { SessionMemory } from './local/memory';
import { NativeLink, type PortLike } from './native';
import { HOST_NAME, type Ask, type StatusAsk } from './protocol';
import { makeRouter, type Engine, type Pins } from './router';

const app = new NativeLink(
  () => chrome.runtime.connectNative(HOST_NAME) as unknown as PortLike,
  () => chrome.runtime.lastError?.message,
);

const store: Store = {
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: (key) => chrome.storage.local.remove(key),
};

const engine = new LocalEngine({
  wasm: async () => {
    const wasm = await import('veil-engine');
    await wasm.default({ module_or_path: chrome.runtime.getURL('veil_engine_wasm_bg.wasm') });
    return wasm;
  },
  store,
  memory: new SessionMemory(chrome.storage.session),
  now: () => Date.now(),
  // Any extension call resets the worker's idle timer.
  keepAlive: () => void chrome.runtime.getPlatformInfo(),
  version: chrome.runtime.getManifest().version,
});

/**
 * Which engine each chat uses: the most recent few hundred, for the browser
 * session, like the built-in engine's placeholders.
 */
const MAX_PINS = 500;
const pins: Pins = {
  async get(key) {
    const all = ((await chrome.storage.session.get('pins')).pins ?? {}) as Record<string, [Engine, number]>;
    return all[key]?.[0];
  },
  async set(key, value) {
    const all = ((await chrome.storage.session.get('pins')).pins ?? {}) as Record<string, [Engine, number]>;
    all[key] = [value, Date.now()];
    const keys = Object.keys(all);
    if (keys.length > MAX_PINS) {
      for (const old of keys.sort((a, b) => all[a]![1] - all[b]![1]).slice(0, keys.length - MAX_PINS)) delete all[old];
    }
    await chrome.storage.session.set({ pins: all });
  },
};

const router = makeRouter(app, { ask: (op, payload) => engine.ask(op, payload), available: () => engine.available() }, pins);

/** What the settings page asks of the built-in engine; see options/localBackend.ts. */
const MANAGE: Record<string, (engine: LocalEngine, args: any[]) => Promise<unknown>> = {
  status: (e) => e.status(),
  config: (e) => e.config(),
  patchConfig: (e, [patch]) => e.patchConfig(patch),
  rules: (e) => e.rulesView(),
  putRules: (e, [rules]) => e.putRules(rules),
  testRules: (e, [req]) => e.testRules(req),
  activity: (e) => e.activity(),
  recentMatches: (e) => e.recentMatches(),
  clearVault: (e) => e.clearVault(),
  setRunning: (e, [running]) => e.setRunning(running),
  enabled: (e) => e.enabled(),
  setEnabled: (e, [on]) => e.setEnabled(on),
};

const OPS = new Set(['status', 'request', 'response', 'observe', 'page_data', 'document', 'open']);

chrome.runtime.onMessage.addListener((msg: Ask, sender, sendResponse) => {
  // Only our own content scripts, popup and settings page can send these.
  if (sender.id !== chrome.runtime.id) return false;
  if (OPS.has(msg.op)) {
    // Opening the app is the popup's button; the sites' pages have no say.
    if (msg.op === 'open' && sender.tab !== undefined) return false;
    // Status checks say which version of the extension asks; the Veil app
    // shows it on its General screen.
    const payload = msg.op === 'status' ? ({ extension: chrome.runtime.getManifest().version } satisfies StatusAsk) : msg.payload;
    router.route(msg.op, payload, { tabUrl: sender.tab?.url, tabId: sender.tab?.id }).then(sendResponse);
    return true;
  }
  if ((msg.op as string) === 'local') {
    // The settings page only; a site's page never reaches the engine's settings.
    if (!sender.url?.startsWith(chrome.runtime.getURL('options.html'))) return false;
    const { method, args } = msg.payload as { method: string; args?: unknown[] };
    const call = MANAGE[method];
    if (!call) {
      sendResponse({ ok: false, error: 'unknown_method' });
      return false;
    }
    call(engine, args ?? []).then(
      (result) => sendResponse({ ok: true, result }),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  }
  if ((msg.op as string) === 'count' && sender.tab?.id !== undefined) {
    void addCount(sender.tab.id, Number((msg.payload as { n?: number })?.n ?? 0));
    return false;
  }
  if ((msg.op as string) === 'tabCount') {
    void tabCount(Number((msg.payload as { tab?: number })?.tab)).then(sendResponse);
    return true;
  }
  return false;
});

async function addCount(tab: number, n: number): Promise<void> {
  if (!(n > 0)) return;
  const key = `count:${tab}`;
  const stored = await chrome.storage.session.get(key);
  const total = Number(stored[key] ?? 0) + n;
  await chrome.storage.session.set({ [key]: total });
  await chrome.action.setBadgeBackgroundColor({ tabId: tab, color: '#35373e' });
  await chrome.action.setBadgeText({ tabId: tab, text: total > 999 ? '999+' : String(total) });
}

async function tabCount(tab: number): Promise<number> {
  const key = `count:${tab}`;
  const stored = await chrome.storage.session.get(key);
  return Number(stored[key] ?? 0);
}

chrome.tabs.onRemoved.addListener((tab) => void chrome.storage.session.remove(`count:${tab}`));
