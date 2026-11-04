import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserVault, type VaultEntry } from '../src/local/vault';

const value = (n: number, v: string, created_ms = 1_000): VaultEntry => ({ t: 'value', scope: 'scope-a', kind: 'EMAIL', n, value: v, created_ms });
const counter = (n: number): VaultEntry => ({ t: 'counter', scope: 'scope-a', kind: 'EMAIL', n });

/** Every byte stored in the database, for searching. */
async function dump(idb: IDBFactory): Promise<string> {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = idb.open('veil');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const all = await new Promise<unknown[][]>((res) => {
    const tx = db.transaction('entries');
    const store = tx.objectStore('entries');
    const keys = store.getAllKeys();
    const values = store.getAll();
    tx.oncomplete = () => res([keys.result as unknown[], values.result]);
  });
  const text = (v: unknown): string => {
    if (v instanceof ArrayBuffer) return Buffer.from(v).toString('latin1') + Buffer.from(v).toString('utf8');
    if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('latin1');
    if (v && typeof v === 'object') return JSON.stringify(Object.entries(v).map(([k, x]) => [k, text(x)]));
    return String(v);
  };
  return text(all);
}

let idb: IDBFactory;
let vault: BrowserVault;
beforeEach(() => {
  idb = new IDBFactory();
  vault = new BrowserVault(idb);
});

describe('the browser vault', () => {
  it('gives back what it saved', async () => {
    await vault.save([{ t: 'key', hex: 'ab'.repeat(32) }, counter(2), value(1, 'ana@example.com'), value(2, 'bob@example.org')]);
    const again = new BrowserVault(idb);
    const loaded = await again.loadAll();
    expect(loaded).toHaveLength(4);
    expect(loaded).toContainEqual(value(1, 'ana@example.com'));
    expect(loaded).toContainEqual({ t: 'key', hex: 'ab'.repeat(32) });
  });

  it('never stores a value, a scope or a kind in the clear', async () => {
    await vault.save([value(1, 'ana.popescu@example.com'), { t: 'bind', id: 'chatgpt:conv-secret', scope: 'scope-a' }]);
    const raw = await dump(idb);
    for (const secret of ['ana.popescu', 'example.com', 'scope-a', 'EMAIL', 'conv-secret']) expect(raw).not.toContain(secret);
  });

  it('keeps the key where scripts can not read it', async () => {
    await vault.save([value(1, 'a@example.com')]);
    const db = await new Promise<IDBDatabase>((res) => {
      const r = idb.open('veil');
      r.onsuccess = () => res(r.result);
    });
    const key = await new Promise<CryptoKey>((res) => {
      const r = db.transaction('keys').objectStore('keys').get('aes-gcm');
      r.onsuccess = () => res(r.result);
    });
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('replaces an entry, and deletes one', async () => {
    await vault.save([value(1, 'a@example.com', 1_000)]);
    await vault.save([value(1, 'a@example.com', 9_000), value(2, 'b@example.com')]);
    await vault.save([{ t: 'delete', scope: 'scope-a', kind: 'EMAIL', n: 2 }]);
    const loaded = await vault.loadAll();
    expect(loaded).toEqual([value(1, 'a@example.com', 9_000)]);
  });

  it('deletes all values and bindings but keeps counters, and the key', async () => {
    await vault.save([{ t: 'key', hex: 'cd'.repeat(32) }, counter(3), value(1, 'a@example.com'), { t: 'bind', id: 'x', scope: 'scope-a' }]);
    await vault.deleteAll();
    const loaded = await vault.loadAll();
    expect(loaded).toContainEqual(counter(3));
    expect(loaded).toContainEqual({ t: 'key', hex: 'cd'.repeat(32) });
    expect(loaded.filter((e) => e.t === 'value' || e.t === 'bind')).toEqual([]);
  });

  it('deletes values older than a number of days', async () => {
    const day = 24 * 60 * 60 * 1000;
    await vault.save([value(1, 'old@example.com', 0), value(2, 'new@example.com', 9 * day)]);
    expect(await vault.deleteOlderThan(7, 10 * day)).toBe(1);
    expect(await vault.loadAll()).toEqual([value(2, 'new@example.com', 9 * day)]);
  });

  it('drops a record that was tampered with, and still loads the rest', async () => {
    await vault.save([value(1, 'a@example.com'), value(2, 'b@example.com')]);
    const db = await new Promise<IDBDatabase>((res) => {
      const r = idb.open('veil');
      r.onsuccess = () => res(r.result);
    });
    await new Promise<void>((res) => {
      const tx = db.transaction('entries', 'readwrite');
      const store = tx.objectStore('entries');
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) {
          const record = c.value;
          new Uint8Array(record.ciphertext)[0]! ^= 1;
          c.update(record);
        }
      };
      tx.oncomplete = () => res();
    });
    const loaded = await new BrowserVault(idb).loadAll();
    expect(loaded.length).toBeLessThan(2);
  });

  it('destroy forgets the key too', async () => {
    await vault.save([value(1, 'a@example.com')]);
    await vault.destroy();
    expect(await new BrowserVault(idb).loadAll()).toEqual([]);
  });
});
