// Messages between the page hook, the content bridge, the service worker
// and the native host. PROTOCOL.md describes what the host receives.

export const HOST_NAME = 'com.veil.app.native';

export type Site = 'claude.ai' | 'chatgpt.com';

/** A request the page is about to send. */
export interface WebRequest {
  site: Site;
  method: string;
  /** Path and query. */
  path: string;
  /** Base64. Absent for GET. */
  body?: string;
}

export interface Decision {
  action: 'pass' | 'rewrite' | 'block';
  /** Base64; set when `action` is `rewrite`. */
  body?: string;
  /** Send the reply to Veil under this ticket. */
  ticket?: string;
  message?: string;
  redacted: number;
}

export interface WebChunk {
  ticket: string;
  /** Base64. */
  chunk?: string;
  done: boolean;
  status?: number;
  content_type?: string;
}

export interface ChunkOut {
  /** Base64. */
  chunk: string;
}

/** What a status check sends: the extension's version, from its manifest. */
export interface StatusAsk {
  extension: string;
}

export interface VeilStatus {
  version: string;
  running: boolean;
  activated: boolean;
  mode: 'redact' | 'audit' | 'off';
  fail_closed: boolean;
  sites: Record<Site, boolean>;
  /** "Capture traffic" is on in Veil: report what the page does, for debugging. */
  capture?: boolean;
}

/** Why the extension couldn't reach Veil. */
export type Failure =
  | 'no_host' // The Veil app isn't installed, or hasn't registered itself yet.
  | 'not_running' // Installed, but not running.
  | 'unauthorized'
  | 'no_token'
  | 'timeout'
  | string;

export type Op = 'status' | 'request' | 'response' | 'observe' | 'page_data';

/** Content script → service worker. */
export interface Ask {
  op: Op;
  payload?: unknown;
}

export type Answer<T = unknown> = { ok: true; result: T } | { ok: false; error: Failure };

/** Per-site choices kept in `chrome.storage.local`. */
export interface Prefs {
  /** Let sends through unprotected when Veil can't be reached. Off by default. */
  unprotected: Partial<Record<Site, boolean>>;
}

export const DEFAULT_PREFS: Prefs = { unprotected: {} };

export function siteOf(hostname: string): Site | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) return 'claude.ai';
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) return 'chatgpt.com';
  return null;
}

/** Bytes ↔ base64, in pieces small enough for `String.fromCharCode`. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
