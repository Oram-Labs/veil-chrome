// Service worker: relays the pages' questions to Veil over native messaging,
// and keeps the count of values hidden in each tab for the toolbar badge.

import { NativeLink, type PortLike } from './native';
import { HOST_NAME, type Ask, type StatusAsk } from './protocol';

const link = new NativeLink(
  () => chrome.runtime.connectNative(HOST_NAME) as unknown as PortLike,
  () => chrome.runtime.lastError?.message,
);

chrome.runtime.onMessage.addListener((msg: Ask, sender, sendResponse) => {
  if (msg.op === 'status' || msg.op === 'request' || msg.op === 'response' || msg.op === 'observe' || msg.op === 'page_data') {
    // Only our own content scripts and popup can send these.
    if (sender.id !== chrome.runtime.id) return false;
    // Status checks say which version of the extension asks; the Veil app
    // shows it on its General screen.
    const payload = msg.op === 'status' ? ({ extension: chrome.runtime.getManifest().version } satisfies StatusAsk) : msg.payload;
    link.ask(msg.op, payload).then(sendResponse);
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
