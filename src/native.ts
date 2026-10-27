// The service worker's connection to the native host (`veil native-host`,
// or the Veil app itself). One port, reopened when it closes.

import type { Answer, Failure, Op } from './protocol';

export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(f: (message: unknown) => void): void };
  onDisconnect: { addListener(f: () => void): void };
}

interface Pending {
  resolve: (answer: Answer) => void;
  timer: ReturnType<typeof setTimeout>;
  parts?: string[];
}

/** Turns Chrome's "host not found" and "host exited" into our failures. */
export function disconnectReason(lastError: string | undefined): Failure {
  const text = (lastError ?? '').toLowerCase();
  if (text.includes('not found') || text.includes('forbidden') || text.includes('not allowed')) return 'no_host';
  return 'host_exited';
}

export class NativeLink {
  private port: PortLike | null = null;
  private next = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private connect: () => PortLike,
    private lastError: () => string | undefined,
    private timeoutMs = 60_000,
  ) {}

  ask<T = unknown>(op: Op, payload?: unknown): Promise<Answer<T>> {
    return new Promise((resolve) => {
      let port: PortLike;
      try {
        port = this.open();
      } catch {
        resolve({ ok: false, error: 'no_host' });
        return;
      }
      const id = this.next++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (a: Answer) => void, timer });
      port.postMessage({ id, op, payload });
    });
  }

  private open(): PortLike {
    if (this.port) return this.port;
    const port = this.connect();
    port.onMessage.addListener((message) => this.receive(message as Record<string, unknown>));
    port.onDisconnect.addListener(() => {
      const reason = disconnectReason(this.lastError());
      if (this.port === port) this.port = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: reason });
        this.pending.delete(id);
      }
    });
    this.port = port;
    return port;
  }

  private receive(message: Record<string, unknown>): void {
    const id = message.id as number;
    const p = this.pending.get(id);
    if (!p) return;
    if (typeof message.parts === 'number') {
      // A long reply, in parts: their `data` joined is the reply's JSON.
      p.parts ??= [];
      p.parts[message.part as number] = message.data as string;
      if (p.parts.filter((x) => x !== undefined).length < (message.parts as number)) return;
      this.finish(id, p, JSON.parse(p.parts.join('')));
      return;
    }
    this.finish(id, p, message);
  }

  private finish(id: number, p: Pending, reply: Record<string, unknown>): void {
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (reply.ok === true) p.resolve({ ok: true, result: reply.result });
    else p.resolve({ ok: false, error: (reply.error as string) ?? 'unknown' });
  }
}
