// The toolbar popup: is Veil reachable, is this site protected, how many
// values were hidden in this tab, and the per-site fallback switch.

import { DEFAULT_PREFS, siteOf, type Answer, type Prefs, type VeilStatus } from '../protocol';
import { describe } from './describe';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = tab?.url ? siteOf(new URL(tab.url).hostname) : null;
  const status: Answer<VeilStatus> = await chrome.runtime.sendMessage({ op: 'status' });
  const count: number = tab?.id !== undefined ? await chrome.runtime.sendMessage({ op: 'tabCount', payload: { tab: tab.id } }) : 0;
  const stored = await chrome.storage.local.get('prefs');
  const prefs: Prefs = { ...DEFAULT_PREFS, ...(stored.prefs as Prefs | undefined) };

  const view = describe(status, site, count, site ? prefs.unprotected[site] === true : false);
  const badge = $('badge');
  badge.textContent = view.badge;
  badge.className = `badge ${view.tone}`;
  $('summary').textContent = view.summary;
  $('help').textContent = view.help;
  const mine = chrome.runtime.getManifest().version;
  $('versions').textContent = status.ok ? `Extension ${mine} · Veil app ${status.result.version}` : `Extension ${mine}`;
  if (site) {
    $('site').hidden = false;
    $('site-name').textContent = site;
    $('site-state').textContent = view.siteState;
    $('count').textContent = view.count;
    $('fallback').hidden = false;
    const toggle = $<HTMLInputElement>('unprotected');
    toggle.checked = prefs.unprotected[site] === true;
    toggle.addEventListener('change', async () => {
      const next: Prefs = { ...prefs, unprotected: { ...prefs.unprotected, [site]: toggle.checked } };
      await chrome.storage.local.set({ prefs: next });
      prefs.unprotected = next.unprotected;
    });
  }
}

void main();
