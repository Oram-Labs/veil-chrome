import { beforeEach, describe, expect, it } from 'vitest';
import { SessionMemory, type MemoryEntry, type SessionArea } from '../src/local/memory';

/** A stand-in for chrome.storage.session, with an optional size limit in entries. */
function area(limit = Infinity): SessionArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async () => Object.fromEntries(data),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) {
        if (!data.has(k) && data.size >= limit) throw new Error('QUOTA_BYTES quota exceeded');
        data.set(k, structuredClone(v));
      }
    },
    remove: async (keys) => {
      for (const k of [keys].flat()) data.delete(k);
    },
  };
}

const value = (n: number, v: string, created_ms = 1_000): MemoryEntry => ({ t: 'value', scope: 's', kind: 'EMAIL', n, value: v, created_ms });

let a: ReturnType<typeof area>;
let memory: SessionMemory;
beforeEach(() => {
  a = area();
  memory = new SessionMemory(a);
});

describe('the session memory', () => {
  it('gives back what it kept, and leaves other session data alone', async () => {
    a.data.set('count:3', 2);
    await memory.save([{ t: 'key', hex: 'ab' }, { t: 'counter', scope: 's', kind: 'EMAIL', n: 2 }, value(1, 'a@example.com'), value(2, 'b@example.com')]);
    const loaded = await new SessionMemory(a).loadAll();
    expect(loaded).toHaveLength(4);
    expect(loaded).toContainEqual(value(1, 'a@example.com'));
    expect(a.data.get('count:3')).toBe(2);
  });

  it('replaces and deletes values', async () => {
    await memory.save([value(1, 'a@example.com', 1), value(2, 'b@example.com')]);
    await memory.save([value(1, 'a@example.com', 9), { t: 'delete', scope: 's', kind: 'EMAIL', n: 2 }]);
    expect(await memory.loadAll()).toEqual([value(1, 'a@example.com', 9)]);
  });

  it('forgets values and bindings on clear, but keeps numbers so none is reused', async () => {
    await memory.save([{ t: 'counter', scope: 's', kind: 'EMAIL', n: 1 }, value(1, 'a@example.com'), { t: 'bind', id: 'x', scope: 's' }, { t: 'clear' }]);
    expect(await memory.loadAll()).toEqual([{ t: 'counter', scope: 's', kind: 'EMAIL', n: 1 }]);
  });

  it('makes room by forgetting the oldest values when the session storage is full', async () => {
    const small = area(4);
    const m = new SessionMemory(small);
    await m.save([value(1, 'old@example.com', 1), value(2, 'b@example.com', 2), value(3, 'c@example.com', 3), value(4, 'd@example.com', 4)]);
    await m.save([value(5, 'new@example.com', 5)]);
    const kept = (await m.loadAll()).map((e) => (e as { value: string }).value);
    expect(kept).toContain('new@example.com');
    expect(kept).not.toContain('old@example.com');
  });

  it('destroy forgets everything it kept, and nothing else', async () => {
    a.data.set('pins', {});
    await memory.save([{ t: 'key', hex: 'ab' }, value(1, 'a@example.com')]);
    await memory.destroy();
    expect(await memory.loadAll()).toEqual([]);
    expect(a.data.has('pins')).toBe(true);
  });
});
