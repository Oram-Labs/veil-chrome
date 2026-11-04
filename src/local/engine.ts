// The built-in engine, running in the service worker: the Veil engine and the
// sites' request handling, compiled to WebAssembly (the `veil-engine`
// package). It answers the same operations as the Veil app (PROTOCOL.md), so
// the rest of the extension doesn't care which one it is talking to.
//
// It keeps three things in the browser: the settings and rules and the
// license key (`chrome.storage.local`), and the vault of placeholders
// (IndexedDB, encrypted: `vault.ts`).

import type { LocalVeil } from 'veil-engine';
import type { ActivityRecord, ConfigView, LicenseView, RecentMatch, RulesFile, RulesView, Settings, StatusView, TestRequest, TestResult } from 'veil-ui';
import type { Answer, Op } from '../protocol';
import { DEFAULT_EXPLANATION, DEFAULT_RULES, DEFAULT_SETTINGS } from './defaults';
import { activityRecords, dayStart, deepMerge, statusView, type Logged } from './shapes';
import type { BrowserVault, VaultEntry } from './vault';

/** Where the settings, rules and license key are kept. */
export interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

type Wasm = typeof import('veil-engine');

export interface Deps {
  /** Loads the WebAssembly. */
  wasm: () => Promise<Wasm>;
  store: Store;
  vault: BrowserVault;
  now: () => number;
  /** Called while a reply is being restored, so the service worker isn't stopped in between. */
  keepAlive?: () => void;
  version?: string;
}

/** Keys in the store. */
const LICENSE = 'license';
const CONFIG = 'config';
const RULES = 'rules';
const ACTIVITY = 'activity';
const LOCAL = 'local';

const HOUR = 60 * 60 * 1000;
const KEEP_ALIVE_MS = 20_000;
/** A reply not finished within this long is no longer waited for. */
const REPLY_MS = 15 * 60 * 1000;
const MAX_ACTIVITY = 500;

export class LocalEngine {
  private starting: Promise<LocalVeil> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private lastPurge = 0;
  private replies = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: Deps) {}

  private veil(): Promise<LocalVeil> {
    this.starting ??= this.start().catch((e) => {
      this.starting = null;
      throw e;
    });
    return this.starting;
  }

  private async start(): Promise<LocalVeil> {
    const { deps } = this;
    const wasm = await deps.wasm();
    const veil = new wasm.LocalVeil(JSON.stringify(await this.rules()), JSON.stringify(await this.settings()));
    veil.set_now(deps.now());
    const key = await deps.store.get(LICENSE);
    if (typeof key === 'string') {
      try {
        veil.set_license(key);
      } catch {
        // A key that no longer checks out stays out; the options page says so.
      }
    }
    veil.load_vault(JSON.stringify(await deps.vault.loadAll()));
    const activity = await deps.store.get(ACTIVITY);
    if (Array.isArray(activity)) veil.load_activity(JSON.stringify(activity));
    this.lastPurge = deps.now();
    veil.purge_expired();
    await this.saveVault(veil);
    return veil;
  }

  private async settings(): Promise<Settings> {
    const stored = (await this.deps.store.get(CONFIG)) as Partial<Settings> | undefined;
    return deepMerge(DEFAULT_SETTINGS, stored ?? {});
  }

  private async rules(): Promise<RulesFile> {
    return ((await this.deps.store.get(RULES)) as RulesFile | undefined) ?? DEFAULT_RULES;
  }

  /** Saves what changed in the vault; one save at a time, in order. */
  private saveVault(veil: LocalVeil): Promise<void> {
    const changes = JSON.parse(veil.take_vault_changes()) as VaultEntry[];
    if (changes.length === 0) return this.saving;
    this.saving = this.saving.then(() => this.deps.vault.save(changes));
    return this.saving;
  }

  /** The built-in engine can be used: a license key is saved, and the person hasn't turned it off. */
  async available(): Promise<boolean> {
    const local = (await this.deps.store.get(LOCAL)) as { enabled?: boolean } | undefined;
    if (local?.enabled === false) return false;
    return (await this.licenseView()).state === 'licensed';
  }

  /** Answers one operation of the protocol, as the Veil app does. */
  async ask<T = unknown>(op: Op, payload?: unknown): Promise<Answer<T>> {
    try {
      const veil = await this.veil();
      veil.set_now(this.deps.now());
      if (this.deps.now() - this.lastPurge > HOUR) {
        this.lastPurge = this.deps.now();
        veil.purge_expired();
      }
      const result = JSON.parse(veil.handle(op, JSON.stringify(payload ?? {}))) as Record<string, unknown>;
      this.trackReply(op, payload, result);
      await this.saveVault(veil);
      if (op !== 'status') this.saveActivitySoon(veil);
      return { ok: true, result: result as T };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Keeps the service worker awake while a reply is being restored. */
  private trackReply(op: Op, payload: unknown, result: Record<string, unknown>): void {
    const now = this.deps.now();
    if (op === 'request' && typeof result.ticket === 'string') this.replies.set(result.ticket, now);
    if (op === 'response' && (payload as { done?: boolean } | undefined)?.done) {
      this.replies.delete(String((payload as { ticket?: string }).ticket));
    }
    for (const [ticket, at] of this.replies) if (now - at > REPLY_MS) this.replies.delete(ticket);
    const { keepAlive } = this.deps;
    if (keepAlive && this.replies.size > 0 && !this.timer) this.timer = setInterval(keepAlive, KEEP_ALIVE_MS);
    if (this.replies.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private saveActivitySoon(veil: LocalVeil): void {
    this.activityTimer ??= setTimeout(() => {
      this.activityTimer = null;
      const log = JSON.parse(veil.activity()) as Logged[];
      void this.deps.store.set(ACTIVITY, log.slice(0, MAX_ACTIVITY));
    }, 1000);
  }

  // What the settings screens ask for ---------------------------------------

  async licenseView(): Promise<LicenseView> {
    const key = await this.deps.store.get(LICENSE);
    const base = { release_date: new Date(this.deps.now()).toISOString().slice(0, 10), source: null, removable: true };
    if (typeof key !== 'string') {
      return { state: 'missing', email: null, name: null, id: null, issued: null, updates_until: null, reason: null, ...base };
    }
    const wasm = await this.deps.wasm();
    try {
      const l = JSON.parse(wasm.check_license(key)) as { id: string; email: string; name?: string; issued: string; updates_until: string };
      return { state: 'licensed', email: l.email, name: l.name ?? null, id: l.id, issued: l.issued, updates_until: l.updates_until, reason: null, ...base, source: 'file' };
    } catch (e) {
      return { state: 'invalid', email: null, name: null, id: null, issued: null, updates_until: null, reason: (e as Error).message, ...base };
    }
  }

  /** Checks a key and, if it is genuine, keeps it. Throws what is wrong with it. */
  async setLicense(key: string): Promise<LicenseView> {
    const wasm = await this.deps.wasm();
    wasm.check_license(key);
    await this.deps.store.set(LICENSE, key.trim());
    if (this.starting) (await this.veil()).set_license(key);
    return this.licenseView();
  }

  async removeLicense(): Promise<LicenseView> {
    await this.deps.store.remove(LICENSE);
    if (this.starting) (await this.veil()).remove_license();
    return this.licenseView();
  }

  async config(): Promise<ConfigView> {
    return { settings: await this.settings(), locked: [], placeholder_explanation_default: DEFAULT_EXPLANATION };
  }

  /** Changes settings. If the engine refuses them, nothing changes and this throws. */
  async patchConfig(patch: Partial<Settings>): Promise<ConfigView> {
    const before = (await this.deps.store.get(CONFIG)) as Partial<Settings> | undefined;
    const next = deepMerge(await this.settings(), patch);
    const veil = await this.veil();
    try {
      veil.configure(JSON.stringify(await this.rules()), JSON.stringify(next));
    } catch (e) {
      veil.configure(JSON.stringify(await this.rules()), JSON.stringify(deepMerge(DEFAULT_SETTINGS, before ?? {})));
      throw e;
    }
    await this.deps.store.set(CONFIG, next);
    return this.config();
  }

  async rulesView(): Promise<RulesView> {
    const rules = await this.rules();
    return { rules, effective: rules, locked: [] };
  }

  /** Replaces the rules. If they don't compile, nothing changes and this throws. */
  async putRules(rules: RulesFile): Promise<RulesView> {
    const veil = await this.veil();
    veil.configure(JSON.stringify(rules), JSON.stringify(await this.settings()));
    await this.deps.store.set(RULES, rules);
    return this.rulesView();
  }

  async testRules(req: TestRequest): Promise<TestResult> {
    const veil = await this.veil();
    veil.set_now(this.deps.now());
    return JSON.parse(veil.test_rules(req.text, req.rules ? JSON.stringify(req.rules) : undefined)) as TestResult;
  }

  async activity(): Promise<ActivityRecord[]> {
    const veil = await this.veil();
    return activityRecords(JSON.parse(veil.activity()) as Logged[]);
  }

  async recentMatches(): Promise<RecentMatch[]> {
    return [];
  }

  async status(): Promise<StatusView> {
    const veil = await this.veil();
    const settings = await this.settings();
    const info = JSON.parse(veil.vault_info()) as { entries: number; oldest_ms: number | null };
    const license = await this.licenseView();
    return statusView({
      version: this.deps.version ?? '0.0.0',
      settings,
      running: !(await this.deps.store.get('paused')),
      activated: license.state === 'licensed',
      licensedTo: license.email,
      log: JSON.parse(veil.activity()) as Logged[],
      now: this.deps.now(),
      vault: info,
    });
  }

  async setRunning(running: boolean): Promise<StatusView> {
    const veil = await this.veil();
    veil.set_running(running);
    if (running) await this.deps.store.remove('paused');
    else await this.deps.store.set('paused', true);
    return this.status();
  }

  /** Forgets every saved value, here and in the browser's storage. */
  async clearVault(): Promise<void> {
    const veil = await this.veil();
    veil.clear_vault();
    await this.saveVault(veil);
  }

  /** Forgets everything the engine kept: values, activity, settings, rules, the license key and the vault key. */
  async deleteEverything(): Promise<void> {
    const veil = await this.veil();
    veil.clear_vault();
    veil.take_vault_changes();
    await this.saving;
    await this.deps.vault.destroy();
    for (const key of [LICENSE, CONFIG, RULES, ACTIVITY, LOCAL, 'paused']) await this.deps.store.remove(key);
    this.starting = null;
  }

  /** Whether the built-in engine is used when the Veil app can't be reached. */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.deps.store.set(LOCAL, { enabled });
  }

  async enabled(): Promise<boolean> {
    return ((await this.deps.store.get(LOCAL)) as { enabled?: boolean } | undefined)?.enabled !== false;
  }

  /** Where "today" starts, for the dashboard. */
  today(): number {
    return dayStart(this.deps.now());
  }
}
