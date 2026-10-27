import { describe, expect, it } from 'vitest';
import { appNotice, extensionNotice, newer, parseLatest, type Latest } from '../src/popup/update';
import type { VeilStatus } from '../src/protocol';

const status: VeilStatus = {
  version: '0.1.21',
  running: true,
  activated: true,
  updates_until: '2027-03-01',
  mode: 'redact',
  fail_closed: true,
  sites: { 'claude.ai': true, 'chatgpt.com': true },
};

const latest: Latest = {
  mac: { version: '0.1.22', date: '2027-02-10' },
  windows: { version: '0.1.21', date: '2026-10-19' },
  chrome: { version: '0.2.0', date: '2026-11-01' },
};

describe('update check', () => {
  it('compares versions as numbers', () => {
    expect(newer('0.1.10', '0.1.9')).toBe(true);
    expect(newer('0.2', '0.1.99')).toBe(true);
    expect(newer('0.1.21', '0.1.21')).toBe(false);
    expect(newer('0.1.21.0', '0.1.21')).toBe(false);
    expect(newer('0.1.9', '0.1.10')).toBe(false);
    expect(newer('1.0.0-beta', '0.1.0')).toBe(false);
  });

  it('offers the download when the key covers the new version', () => {
    expect(appNotice(status, latest, 'mac')).toEqual({
      text: 'Veil 0.1.22 is available.',
      link: 'Download',
      href: 'https://getveil.tech/download/Veil-mac.dmg',
    });
    // Released on the key's last day of updates: still covered.
    expect(appNotice({ ...status, updates_until: '2027-02-10' }, latest, 'mac')?.link).toBe('Download');
  });

  it('offers renewing when the key does not cover it', () => {
    const notice = appNotice({ ...status, updates_until: '2027-02-09' }, latest, 'mac');
    expect(notice).toMatchObject({ link: 'Renew', href: 'https://getveil.tech/pricing' });
    expect(notice?.text).toContain('Your updates ended on 9 Feb 2027');
  });

  it("says which date matters when the app doesn't report one", () => {
    const { updates_until: _, ...old } = status;
    const notice = appNotice(old, latest, 'mac');
    expect(notice?.link).toBe('Download');
    expect(notice?.text).toContain('if its updates run to 10 Feb 2027 or later');
  });

  it('says nothing when up to date, not activated, or on another platform', () => {
    expect(appNotice(status, latest, 'win')).toBeNull();
    expect(appNotice({ ...status, version: '0.1.23' }, latest, 'mac')).toBeNull();
    expect(appNotice({ ...status, activated: false }, latest, 'mac')).toBeNull();
    expect(appNotice(status, latest, 'linux')).toBeNull();
    expect(appNotice(status, {}, 'mac')).toBeNull();
  });

  it('offers the AppImage on Linux, and nothing on other systems', () => {
    const withLinux: Latest = { ...latest, linux: { version: '0.1.22', date: '2027-02-10' } };
    expect(appNotice(status, withLinux, 'linux')?.href).toBe('https://getveil.tech/download/Veil-linux.AppImage');
    expect(appNotice(status, withLinux, 'cros')).toBeNull();
  });

  it("tells zip installs about a newer extension, but not the Web Store's", () => {
    expect(extensionNotice('0.1.0', false, latest)).toMatchObject({
      link: 'Download',
      href: 'https://getveil.tech/download/Veil-chrome.zip',
    });
    expect(extensionNotice('0.1.0', true, latest)).toBeNull();
    expect(extensionNotice('0.2.0', false, latest)).toBeNull();
  });

  it('keeps only the fields it uses from latest.json', () => {
    const parsed = parseLatest({
      mac: { version: '0.1.22', date: '2027-02-10', file: 'x.dmg', sha256: 'ab' },
      windows: { version: 22 },
      linux: { version: '1.0.0', date: '2027-01-01', file: 'x.AppImage' },
      other: { version: '9.9.9', date: '2027-01-01' },
    });
    expect(parsed).toEqual({ mac: { version: '0.1.22', date: '2027-02-10' }, linux: { version: '1.0.0', date: '2027-01-01' } });
    expect(parseLatest('nope')).toEqual({});
  });
});
