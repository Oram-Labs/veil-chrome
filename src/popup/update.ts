// Is a newer Veil app or extension out? The popup reads the site's
// latest.json (the same file its Download section shows) and compares it
// with what's installed. Nothing about the user is sent: it's a plain GET.
//
// A key covers app versions released up to its "updates until" date. A newer
// version it doesn't cover would refuse the key, so then the popup offers
// renewing instead of the download.

import type { VeilStatus } from '../protocol';

export const SITE = 'https://getveil.tech';
export const LATEST_URL = `${SITE}/download/latest.json`;

/** One platform's entry in latest.json. */
export interface Release {
  version: string;
  /** YYYY-MM-DD; keys compare their "updates until" with it. */
  date: string;
}

export interface Latest {
  mac?: Release;
  windows?: Release;
  linux?: Release;
  chrome?: Release;
}

export interface Notice {
  text: string;
  link: string;
  href: string;
}

/** Stable download links; they always point at the newest version. */
const DOWNLOADS = {
  mac: `${SITE}/download/Veil-mac.dmg`,
  windows: `${SITE}/download/Veil-windows.exe`,
  linux: `${SITE}/download/Veil-linux.AppImage`,
  chrome: `${SITE}/download/Veil-chrome.zip`,
};

/** `a` is a later version than `b`. Versions are dotted numbers. */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if ([...pa, ...pb].some((n) => !Number.isInteger(n) || n < 0)) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-10-08" → "8 Oct 2026". */
export function showDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** What to say about the app, if a newer version for this computer is out. */
export function appNotice(status: VeilStatus, latest: Latest, os: string): Notice | null {
  const platform = os === 'mac' ? 'mac' : os === 'win' ? 'windows' : os === 'linux' ? 'linux' : undefined;
  const release = platform && latest[platform];
  if (!status.activated || !release || !DATE.test(release.date) || !newer(release.version, status.version)) return null;
  const href = DOWNLOADS[platform!];
  const until = status.updates_until;
  if (until === undefined || !DATE.test(until)) {
    // An older app that doesn't say until when its key gets updates.
    return {
      text: `Veil ${release.version} is available. Your key works with it if its updates run to ${showDate(release.date)} or later.`,
      link: 'Download',
      href,
    };
  }
  if (release.date <= until) {
    return { text: `Veil ${release.version} is available.`, link: 'Download', href };
  }
  return {
    text: `Veil ${release.version} is out. Your updates ended on ${showDate(until)}, so renew to get it. The version you have keeps working.`,
    link: 'Renew',
    href: `${SITE}/pricing`,
  };
}

/** What to say about this extension, if a newer one is out. Chrome updates
 * Web Store installs itself, so only installs from the zip need telling. */
export function extensionNotice(installed: string, fromStore: boolean, latest: Latest): Notice | null {
  const release = latest.chrome;
  if (fromStore || !release || !newer(release.version, installed)) return null;
  return { text: `Version ${release.version} of this extension is available.`, link: 'Download', href: DOWNLOADS.chrome };
}

/** Keeps only the fields used, so an odd file can't put anything else on screen. */
export function parseLatest(value: unknown): Latest {
  const out: Latest = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const key of ['mac', 'windows', 'linux', 'chrome'] as const) {
    const r = (value as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
    if (r && typeof r.version === 'string' && typeof r.date === 'string') {
      out[key] = { version: r.version, date: r.date };
    }
  }
  return out;
}

/** How long a fetched latest.json is used before asking again. */
const FRESH_MS = 6 * 60 * 60 * 1000;

/** latest.json, from the last six hours or fetched now. Null when the site
 * can't be reached and nothing was fetched before. */
export async function loadLatest(now = Date.now()): Promise<Latest | null> {
  const stored = (await chrome.storage.local.get('latest')).latest as { at: number; data: unknown } | undefined;
  if (stored && now - stored.at < FRESH_MS && now >= stored.at) return parseLatest(stored.data);
  try {
    const res = await fetch(LATEST_URL, { signal: AbortSignal.timeout(5000), credentials: 'omit' });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data: unknown = await res.json();
    await chrome.storage.local.set({ latest: { at: now, data: parseLatest(data) } });
    return parseLatest(data);
  } catch {
    return stored ? parseLatest(stored.data) : null;
  }
}
