// The built-in engine's answers in the shapes the settings screens (veil-ui)
// expect, which are the Veil app's: plain functions, so they can be tested.

import type { ActivityRecord, Outcome, Settings, StatusView } from 'veil-ui';

/** One thing the engine did, as it reports it. */
export interface Logged {
  at_ms: number;
  site: string;
  route: string;
  mode: string;
  redacted: Record<string, number>;
  restored: number;
  unsupported_parts: number;
  outcome: Outcome;
  upstream_status: number | null;
  error: string | null;
  documents: number;
}

type Plain = Record<string, unknown>;

/** `patch` laid over `base`, object by object; arrays and other values are replaced. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return (patch === undefined ? base : (patch as T));
  const out: Plain = { ...(base as Plain) };
  for (const [key, value] of Object.entries(patch as Plain)) {
    const current = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)
        ? deepMerge(current, value)
        : value;
  }
  return out as T;
}

/** The start of the local day containing `ms`. */
export function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function activityRecords(log: Logged[]): ActivityRecord[] {
  return log.map((a) => ({
    at_ms: a.at_ms,
    channel: 'extension',
    provider: a.site,
    route: a.route,
    model: null,
    mode: a.mode,
    redacted: a.redacted,
    restored: a.restored,
    unknown_placeholders: 0,
    unknown_events: 0,
    unsupported_parts: a.unsupported_parts,
    documents: a.documents,
    document_pages: 0,
    outcome: a.outcome,
    added_ms: 0,
    upstream_status: a.upstream_status,
    error: a.error,
  }));
}

export interface StatusInput {
  version: string;
  settings: Settings;
  running: boolean;
  activated: boolean;
  licensedTo: string | null;
  log: Logged[];
  now: number;
  vault: { entries: number; oldest_ms: number | null };
}

export function statusView(i: StatusInput): StatusView {
  const start = dayStart(i.now);
  const today = i.log.filter((a) => a.at_ms >= start);
  const redactedByKind: Record<string, number> = {};
  for (const a of today) for (const [kind, n] of Object.entries(a.redacted)) redactedByKind[kind] = (redactedByKind[kind] ?? 0) + n;
  const count = (outcome: Outcome) => today.filter((a) => a.outcome === outcome).length;
  const requests = today.filter((a) => a.route !== 'web_page_data').length;
  const last = i.log.find((a) => a.error);
  return {
    version: i.version,
    components: [{ name: 'veil-engine (built in)', version: i.version, checksum: null, url: '' }],
    running: i.running,
    mode: i.settings.behavior.mode,
    day: Math.floor(start / 86_400_000),
    requests_today: requests,
    channels: {
      extension: { requests_today: requests, last_seen_ms: i.log[0]?.at_ms ?? null },
      desktop: { requests_today: 0, last_seen_ms: null },
      api: { requests_today: 0, last_seen_ms: null },
    },
    redacted_today: Object.values(redactedByKind).reduce((a, b) => a + b, 0),
    redacted_by_kind_today: redactedByKind,
    blocked_today: count('blocked'),
    warned_today: count('warned'),
    errors_today: count('error'),
    added_latency_median_ms: 0,
    added_latency_p95_ms: 0,
    unknown_placeholders: 0,
    unknown_events: 0,
    last_error: last ? { at_ms: last.at_ms, code: last.error! } : null,
    config_error: null,
    listen_error: null,
    ner_error: null,
    restart_required: false,
    desktop_unprotected: [],
    activated: i.activated,
    licensed_to: i.licensedTo,
    extension_version: null,
    endpoints: {},
    vault: { entries: i.vault.entries, oldest_created_at: i.vault.oldest_ms === null ? null : Math.floor(i.vault.oldest_ms / 1000), persistent: true },
  };
}
