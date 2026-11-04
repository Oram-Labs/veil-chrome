import { describe, expect, it } from 'vitest';
import { describe as view } from '../src/popup/describe';
import type { Answer, VeilStatus } from '../src/protocol';

const status = (extra: Partial<VeilStatus> = {}): Answer<VeilStatus> => ({
  ok: true,
  result: { version: '0.1.28', running: true, activated: true, mode: 'redact', fail_closed: true, sites: { 'claude.ai': true, 'chatgpt.com': true }, ...extra },
});

describe('the popup', () => {
  it('offers the built-in engine when the app is missing', () => {
    const v = view({ ok: false, error: 'no_host' }, 'claude.ai', 0, false);
    expect(v.action?.kind).toBe('download');
    expect(v.settings).toBeTruthy();
    expect(v.help).toContain('license key');
  });

  it('offers it when the app is not running too', () => {
    const v = view({ ok: false, error: 'not_running' }, 'claude.ai', 0, false);
    expect(v.action?.kind).toBe('open');
    expect(v.settings).toBeTruthy();
  });

  it('says when the built-in engine is the one working, and what it can\'t do', () => {
    const v = view(status({ engine: 'builtin' }), 'claude.ai', 2, false);
    expect(v.badge).toBe('Protecting');
    expect(v.help).toMatch(/built-in engine/);
    expect(v.help).toMatch(/PDF/);
    expect(v.settings).toBe('Settings');
  });

  it('says nothing about the built-in engine when the app answers', () => {
    const v = view(status(), 'claude.ai', 0, false);
    expect(v.settings).toBeUndefined();
    expect(v.help).not.toMatch(/built-in/);
  });
});
