// The built-in engine's placeholders, for the browser session only: which
// value each placeholder stands for, kept in `chrome.storage.session`, which
// Chrome holds in memory and empties when the browser closes. Nothing is
// written to disk. The engine itself holds them too; this lets them outlive
// the service worker, which Chrome stops when it is idle.
//
// The Veil app keeps them for good, encrypted, on the computer; without it,
// a chat from before the browser restarted shows its placeholders.

/** One thing the engine reports about its placeholders. */
export type MemoryEntry =
  | { t: 'key'; hex: string }
  | { t: 'value'; scope: string; kind: string; n: number; value: string; created_ms: number }
  | { t: 'counter'; scope: string; kind: string; n: number }
  | { t: 'bind'; id: string; scope: string }
  | { t: 'delete'; scope: string; kind: string; n: number }
  | { t: 'clear' };

/** The part of `chrome.storage.session` used here. */
export interface SessionArea {
  get(keys: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

const PREFIX = 'm:';

function name(entry: Exclude<MemoryEntry, { t: 'clear' }>): string {
  switch (entry.t) {
    case 'key':
      return `${PREFIX}key`;
    case 'value':
    case 'delete':
      return `${PREFIX}v|${entry.scope}|${entry.kind}|${entry.n}`;
    case 'counter':
      return `${PREFIX}c|${entry.scope}|${entry.kind}`;
    case 'bind':
      return `${PREFIX}b|${entry.id}`;
  }
}

export class SessionMemory {
  constructor(private area: SessionArea) {}

  private async mine(): Promise<Record<string, MemoryEntry>> {
    const all = await this.area.get(null);
    return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(PREFIX))) as Record<string, MemoryEntry>;
  }

  /** Everything kept this session. */
  async loadAll(): Promise<MemoryEntry[]> {
    return Object.values(await this.mine());
  }

  /** Keeps what changed, in order. When the session's storage is full, the oldest values make room. */
  async save(changes: MemoryEntry[]): Promise<void> {
    for (const entry of changes) {
      if (entry.t === 'clear') {
        const keys = Object.keys(await this.mine()).filter((k) => k.startsWith(`${PREFIX}v|`) || k.startsWith(`${PREFIX}b|`));
        if (keys.length > 0) await this.area.remove(keys);
      } else if (entry.t === 'delete') {
        await this.area.remove(name(entry));
      } else {
        const item = { [name(entry)]: entry };
        try {
          await this.area.set(item);
        } catch {
          await this.makeRoom();
          await this.area.set(item);
        }
      }
    }
  }

  /** Forgets the oldest quarter of the values. */
  private async makeRoom(): Promise<void> {
    const values = Object.entries(await this.mine())
      .filter((e): e is [string, Extract<MemoryEntry, { t: 'value' }>] => e[1].t === 'value')
      .sort((a, b) => a[1].created_ms - b[1].created_ms);
    const drop = values.slice(0, Math.max(1, Math.ceil(values.length / 4))).map(([k]) => k);
    if (drop.length > 0) await this.area.remove(drop);
  }

  /** Forgets everything, numbers and key included. */
  async destroy(): Promise<void> {
    const keys = Object.keys(await this.mine());
    if (keys.length > 0) await this.area.remove(keys);
  }
}
