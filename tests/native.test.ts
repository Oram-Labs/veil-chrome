import { describe, expect, it } from 'vitest';
import { NativeLink, disconnectReason, type PortLike } from '../src/native';

class FakePort implements PortLike {
  sent: Record<string, unknown>[] = [];
  private onMsg: ((m: unknown) => void)[] = [];
  private onDisc: (() => void)[] = [];
  onMessage = { addListener: (f: (m: unknown) => void) => this.onMsg.push(f) };
  onDisconnect = { addListener: (f: () => void) => this.onDisc.push(f) };
  postMessage(m: unknown) {
    this.sent.push(m as Record<string, unknown>);
  }
  disconnect() {}
  reply(m: unknown) {
    this.onMsg.forEach((f) => f(m));
  }
  drop() {
    this.onDisc.forEach((f) => f());
  }
}

describe('NativeLink', () => {
  it('matches replies to questions, and joins replies sent in parts', async () => {
    const port = new FakePort();
    const link = new NativeLink(() => port, () => undefined);
    const a = link.ask('status');
    const b = link.ask('request', { x: 1 });
    expect(port.sent.map((m) => m.op)).toEqual(['status', 'request']);
    const json = JSON.stringify({ id: port.sent[1].id, ok: true, result: { action: 'pass', redacted: 0 } });
    port.reply({ id: port.sent[1].id, part: 1, parts: 2, data: json.slice(10) });
    port.reply({ id: port.sent[1].id, part: 0, parts: 2, data: json.slice(0, 10) });
    port.reply({ id: port.sent[0].id, ok: false, error: 'not_running' });
    expect(await a).toEqual({ ok: false, error: 'not_running' });
    expect(await b).toEqual({ ok: true, result: { action: 'pass', redacted: 0 } });
  });

  it('fails waiting questions when the host goes away, then reconnects', async () => {
    const ports: FakePort[] = [];
    let error: string | undefined = 'Specified native messaging host not found.';
    const link = new NativeLink(
      () => {
        const p = new FakePort();
        ports.push(p);
        return p;
      },
      () => error,
    );
    const a = link.ask('status');
    ports[0].drop();
    expect(await a).toEqual({ ok: false, error: 'no_host' });
    error = undefined;
    const b = link.ask('status');
    expect(ports).toHaveLength(2);
    ports[1].reply({ id: ports[1].sent[0].id, ok: true, result: {} });
    expect(await b).toEqual({ ok: true, result: {} });
  });

  it('times out', async () => {
    const link = new NativeLink(() => new FakePort(), () => undefined, 5);
    expect(await link.ask('status')).toEqual({ ok: false, error: 'timeout' });
  });

  it('names disconnect reasons', () => {
    expect(disconnectReason('Specified native messaging host not found.')).toBe('no_host');
    expect(disconnectReason('Access to the specified native messaging host is forbidden.')).toBe('no_host');
    expect(disconnectReason('Native host has exited.')).toBe('host_exited');
  });
});
