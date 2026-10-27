import { describe, expect, it } from 'vitest';
import { interesting, sends } from '../src/sites';
import { describe as view, openOutcome } from '../src/popup/describe';
import { fromBase64, siteOf, toBase64, type VeilStatus } from '../src/protocol';

describe('sites', () => {
  it('knows the sites', () => {
    expect(siteOf('claude.ai')).toBe('claude.ai');
    expect(siteOf('chatgpt.com')).toBe('chatgpt.com');
    expect(siteOf('ab.chatgpt.com')).toBe('chatgpt.com');
    expect(siteOf('example.com')).toBeNull();
    expect(siteOf('claude.ai.evil.com')).toBeNull();
  });

  it('sends only chat requests to Veil', () => {
    expect(interesting('claude.ai', 'POST', '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction')).toBe(true);
    expect(interesting('claude.ai', 'POST', '/api/organizations/o/chat_conversations/c/completion')).toBe(true);
    expect(interesting('claude.ai', 'GET', '/api/organizations/o/chat_conversations_v2?limit=30')).toBe(true);
    expect(interesting('claude.ai', 'GET', '/api/organizations/o/projects')).toBe(false);
    expect(interesting('claude.ai', 'DELETE', '/api/organizations/o/chat_conversations/c')).toBe(false);
    expect(interesting('chatgpt.com', 'POST', '/backend-api/f/conversation')).toBe(true);
    expect(interesting('chatgpt.com', 'GET', '/backend-api/conversation/abc')).toBe(true);
    expect(interesting('chatgpt.com', 'GET', '/backend-api/conversations?offset=0')).toBe(true);
    expect(interesting('chatgpt.com', 'POST', '/backend-api/sentinel/chat-requirements')).toBe(false);
    expect(interesting('chatgpt.com', 'GET', '/backend-api/me')).toBe(false);
  });

  it('only blocks requests that may carry text', () => {
    expect(sends('POST', '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction')).toBe(true);
    expect(sends('POST', '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline')).toBe(false);
    expect(sends('GET', '/backend-api/conversation/abc')).toBe(false);
    expect(sends('POST', '/backend-api/f/conversation')).toBe(true);
  });

  it('round-trips base64, including large and non-ASCII bytes', () => {
    const bytes = new TextEncoder().encode('ă'.repeat(100_000) + '\u{1F600}');
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe('popup', () => {
  const status: VeilStatus = {
    version: '0.1.10',
    running: true,
    activated: true,
    mode: 'redact',
    fail_closed: true,
    sites: { 'claude.ai': true, 'chatgpt.com': false },
  };

  it('says what is going on', () => {
    expect(view({ ok: true, result: status }, 'claude.ai', 3, false)).toMatchObject({
      badge: 'Protecting',
      tone: 'ok',
      siteState: 'Protected',
      count: '3 values hidden in this tab.',
    });
    expect(view({ ok: true, result: status }, 'chatgpt.com', 0, false).siteState).toBe('Off in Veil');
    expect(view({ ok: true, result: { ...status, running: false } }, 'claude.ai', 0, false).badge).toBe('Paused');
    expect(view({ ok: false, error: 'no_host' }, 'claude.ai', 0, false).badge).toBe('Not installed');
    expect(view({ ok: false, error: 'not_running' }, 'claude.ai', 1, true)).toMatchObject({
      badge: 'Not running',
      siteState: 'Sending unprotected',
      count: '1 value hidden in this tab.',
    });
  });

  it('offers the download or opening Veil when it cannot be reached', () => {
    expect(view({ ok: false, error: 'no_host' }, null, 0, false).action).toEqual({
      kind: 'download',
      label: 'Download Veil',
      href: 'https://getveil.tech/#download',
    });
    expect(view({ ok: false, error: 'not_running' }, 'claude.ai', 0, false).action).toEqual({ kind: 'open', label: 'Open Veil' });
    expect(view({ ok: true, result: status }, 'claude.ai', 0, false).action).toBeUndefined();
  });

  it('waits for Veil after opening it, unless this version cannot open itself', () => {
    expect(openOutcome({ ok: true, result: { started: true } })).toEqual({ wait: true });
    expect(openOutcome({ ok: false, error: 'unknown_op' })).toMatchObject({ wait: false });
  });
});
