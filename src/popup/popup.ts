// The toolbar popup: is Veil reachable, is this site protected, how many
// values were hidden in this tab, and the per-site fallback switch.

import { DEFAULT_PREFS, siteOf, type Answer, type Prefs, type VeilStatus } from '../protocol';
import { describe, openOutcome, type View } from './describe';
import { appNotice, extensionNotice, loadLatest, type Notice } from './update';

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
  if (view.action) showAction(view.action);
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
  // After the rest is on screen: the site may be slow or unreachable.
  void showUpdates(status);
}

function showAction(action: NonNullable<View['action']>): void {
  $('action').hidden = false;
  if (action.kind === 'download') {
    const link = $<HTMLAnchorElement>('download');
    link.href = action.href;
    link.textContent = action.label;
    link.hidden = false;
    return;
  }
  const button = $<HTMLButtonElement>('open');
  button.textContent = action.label;
  button.hidden = false;
  button.addEventListener('click', () => void openVeil(button));
}

/** Asks Veil's helper to open the app, then waits for it to answer. */
async function openVeil(button: HTMLButtonElement): Promise<void> {
  const note = $('action-note');
  button.disabled = true;
  button.textContent = 'Opening…';
  note.hidden = true;
  const answer: Answer = await chrome.runtime.sendMessage({ op: 'open' });
  const outcome = openOutcome(answer);
  if (outcome.wait) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const status: Answer<VeilStatus> = await chrome.runtime.sendMessage({ op: 'status' });
      if (status.ok) {
        location.reload();
        return;
      }
    }
  }
  note.textContent = outcome.wait ? 'Veil is taking a while to start. Open this again in a moment.' : outcome.note;
  note.hidden = false;
  button.hidden = !outcome.wait;
  button.disabled = false;
  button.textContent = 'Open Veil';
}

async function showUpdates(status: Answer<VeilStatus>): Promise<void> {
  const latest = await loadLatest();
  if (!latest) return;
  const manifest = chrome.runtime.getManifest();
  const { os } = await chrome.runtime.getPlatformInfo();
  const notices = [
    status.ok ? appNotice(status.result, latest, os) : null,
    extensionNotice(manifest.version, manifest.update_url !== undefined, latest),
  ].filter((n): n is Notice => n !== null);
  $('updates').replaceChildren(...notices.map(card));
}

function card(notice: Notice): HTMLElement {
  const section = document.createElement('section');
  section.className = 'card update';
  const text = document.createElement('span');
  text.textContent = notice.text;
  const link = document.createElement('a');
  link.href = notice.href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = notice.link;
  section.append(text, link);
  return section;
}

void main();
