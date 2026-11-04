// The built-in engine's vault, kept in the browser: which value each
// placeholder stands for, encrypted. The engine holds the vault in memory and
// reports each change (`take_vault_changes`); this saves them, and gives the
// saved entries back when the engine starts.
//
// Each entry is encrypted with AES-GCM under a key made on first use and kept
// in IndexedDB as a non-extractable CryptoKey: no script can read its bytes,
// but a script running as this extension can still ask the browser to use it,
// and so can anyone who can read this browser profile while it is unlocked.
// There is no passphrase. THREAT_MODEL.md says what that does and doesn't
// protect against.

/** One thing saved about the vault, as the engine reports it. */
export type VaultEntry =
  | { t: 'key'; hex: string }
  | { t: 'value'; scope: string; kind: string; n: number; value: string; created_ms: number }
  | { t: 'counter'; scope: string; kind: string; n: number }
  | { t: 'bind'; id: string; scope: string }
  | { t: 'delete'; scope: string; kind: string; n: number }
  | { t: 'clear' };

/** A saved record. `kind` says what it holds, so some can be deleted without decrypting. */
interface Record {
  kind: 'key' | 'value' | 'counter' | 'bind';
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
  /** Only for values, so old ones can be deleted without decrypting. */
  created_ms?: number;
}

const DB_NAME = 'veil';
const ENTRIES = 'entries';
const KEYS = 'keys';
const KEY_ID = 'aes-gcm';

const utf8 = new TextEncoder();

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The record's name: a hash of what the entry is, so names reveal nothing. */
async function recordName(entry: VaultEntry): Promise<string> {
  const logical = (() => {
    switch (entry.t) {
      case 'key':
        return 'key';
      case 'value':
      case 'delete':
        return `v|${entry.scope}|${entry.kind}|${entry.n}`;
      case 'counter':
        return `c|${entry.scope}|${entry.kind}`;
      case 'bind':
        return `b|${entry.id}`;
      case 'clear':
        return 'clear';
    }
  })();
  return hex(await crypto.subtle.digest('SHA-256', utf8.encode(logical)));
}

export class BrowserVault {
  private db: Promise<IDBDatabase> | null = null;
  private key: Promise<CryptoKey> | null = null;

  constructor(private idb: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const r = this.idb.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(ENTRIES);
        r.result.createObjectStore(KEYS);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.db;
  }

  /** The encryption key: made on first use, then kept. */
  private cryptoKey(): Promise<CryptoKey> {
    this.key ??= (async () => {
      const db = await this.open();
      const existing = await request<CryptoKey | undefined>(db.transaction(KEYS).objectStore(KEYS).get(KEY_ID));
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const tx = db.transaction(KEYS, 'readwrite');
      tx.objectStore(KEYS).put(key, KEY_ID);
      await done(tx);
      return key;
    })();
    return this.key;
  }

  private async encrypt(name: string, entry: VaultEntry): Promise<Record> {
    const key = await this.cryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8.encode(name) },
      key,
      utf8.encode(JSON.stringify(entry)),
    );
    const kind = entry.t as Record['kind'];
    return { kind, iv, ciphertext, ...(entry.t === 'value' ? { created_ms: entry.created_ms } : {}) };
  }

  private async decrypt(name: string, record: Record): Promise<VaultEntry> {
    const key = await this.cryptoKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv as BufferSource, additionalData: utf8.encode(name) },
      key,
      record.ciphertext,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as VaultEntry;
  }

  /** Every saved entry, decrypted. An entry that doesn't decrypt is skipped and deleted. */
  async loadAll(): Promise<VaultEntry[]> {
    const db = await this.open();
    const store = db.transaction(ENTRIES).objectStore(ENTRIES);
    const [names, records] = await Promise.all([
      request<IDBValidKey[]>(store.getAllKeys()),
      request<Record[]>(store.getAll()),
    ]);
    const out: VaultEntry[] = [];
    const broken: string[] = [];
    for (let i = 0; i < names.length; i++) {
      try {
        out.push(await this.decrypt(String(names[i]), records[i]!));
      } catch {
        broken.push(String(names[i]));
      }
    }
    if (broken.length > 0) {
      const tx = db.transaction(ENTRIES, 'readwrite');
      for (const name of broken) tx.objectStore(ENTRIES).delete(name);
      await done(tx);
    }
    return out;
  }

  /** Saves what changed, in order. */
  async save(changes: VaultEntry[]): Promise<void> {
    if (changes.length === 0) return;
    const db = await this.open();
    // Encrypt first: a transaction closes if it waits for anything but IndexedDB.
    const writes: { name: string; record: Record | null; clear?: boolean }[] = [];
    for (const entry of changes) {
      if (entry.t === 'clear') {
        writes.push({ name: '', record: null, clear: true });
        continue;
      }
      const name = await recordName(entry);
      writes.push({ name, record: entry.t === 'delete' ? null : await this.encrypt(name, entry) });
    }
    const tx = db.transaction(ENTRIES, 'readwrite');
    const store = tx.objectStore(ENTRIES);
    for (const w of writes) {
      if (w.clear) {
        // Values and bindings go; counters and the key stay.
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          const kind = (c.value as Record).kind;
          if (kind === 'value' || kind === 'bind') c.delete();
          c.continue();
        };
      } else if (w.record) store.put(w.record, w.name);
      else store.delete(w.name);
    }
    await done(tx);
  }

  /** Forgets every value and binding. Counters stay, so a number is never reused. */
  async deleteAll(): Promise<void> {
    await this.save([{ t: 'clear' }]);
  }

  /** Forgets values stored more than `days` days before `now` (milliseconds). */
  async deleteOlderThan(days: number, now: number = Date.now()): Promise<number> {
    const db = await this.open();
    const limit = now - days * 24 * 60 * 60 * 1000;
    const tx = db.transaction(ENTRIES, 'readwrite');
    const store = tx.objectStore(ENTRIES);
    let deleted = 0;
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      const record = c.value as Record;
      if (record.kind === 'value' && (record.created_ms ?? 0) < limit) {
        c.delete();
        deleted++;
      }
      c.continue();
    };
    await done(tx);
    return deleted;
  }

  /** Forgets everything, including the key. */
  async destroy(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([ENTRIES, KEYS], 'readwrite');
    tx.objectStore(ENTRIES).clear();
    tx.objectStore(KEYS).clear();
    await done(tx);
    this.key = null;
  }
}
