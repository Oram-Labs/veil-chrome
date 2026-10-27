// What the popup says, as plain data so it can be tested.

import type { Answer, Site, VeilStatus } from '../protocol';

export interface View {
  badge: string;
  tone: 'ok' | 'warn' | 'bad';
  summary: string;
  siteState: string;
  count: string;
  help: string;
}

export function describe(status: Answer<VeilStatus>, site: Site | null, count: number, unprotected: boolean): View {
  const count_text =
    count === 0 ? 'Nothing hidden in this tab yet.' : `${count} value${count === 1 ? '' : 's'} hidden in this tab.`;
  if (!status.ok) {
    const missing = status.error === 'no_host';
    return {
      badge: missing ? 'Not installed' : 'Not running',
      tone: 'bad',
      summary: missing
        ? "The Veil app isn't installed, or hasn't been opened since it was installed."
        : "Veil isn't running.",
      siteState: unprotected ? 'Sending unprotected' : 'Messages wait for Veil',
      count: count_text,
      help: missing
        ? 'Install the Veil app and open it once. Then reload this page.'
        : unprotected
          ? 'Open the Veil app. Until then, messages on this site are sent unprotected.'
          : 'Open the Veil app. Until then, messages on this site are blocked, not sent unprotected.',
    };
  }
  const s = status.result;
  const siteOn = site ? s.sites[site] : false;
  if (!s.running) {
    return {
      badge: 'Paused',
      tone: 'warn',
      summary: 'Veil is paused. Messages on protected sites are blocked until you resume it.',
      siteState: siteOn ? 'Blocked while paused' : 'Off in Veil',
      count: count_text,
      help: 'Resume Veil from its menu bar or tray icon.',
    };
  }
  if (!s.activated) {
    return {
      badge: 'Not activated',
      tone: 'warn',
      summary: "Veil isn't activated yet, so messages on protected sites are blocked.",
      siteState: siteOn ? 'Blocked' : 'Off in Veil',
      count: count_text,
      help: 'Open Veil and enter your license key.',
    };
  }
  const mode =
    s.mode === 'redact'
      ? { badge: 'Protecting', tone: 'ok' as const, state: 'Protected' }
      : s.mode === 'audit'
        ? { badge: 'Audit only', tone: 'warn' as const, state: 'Audit only: sent unchanged' }
        : { badge: 'Off', tone: 'warn' as const, state: 'Veil is off' };
  return {
    badge: mode.badge,
    tone: mode.tone,
    summary:
      s.mode === 'redact'
        ? 'Sensitive values are replaced before the site sends your message, and shown again in replies.'
        : s.mode === 'audit'
          ? 'Audit mode: messages are sent unchanged; Veil only counts what it would hide.'
          : 'Veil is turned off. Messages are sent unchanged.',
    siteState: siteOn ? mode.state : 'Off in Veil',
    count: count_text,
    help: site ? `Veil ${s.version}. Choose protected sites in Veil, under Client setup.` : 'Open claude.ai or chatgpt.com to see this site.',
  };
}
