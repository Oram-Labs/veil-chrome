// The settings screens' host: the built-in engine in the service worker,
// reached with messages. The screens are the Veil app's (veil-ui).

import type { Backend, RulesView, ScreenName } from 'veil-ui';

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const answer: { ok: boolean; result?: T; error?: string } | undefined = await chrome.runtime.sendMessage({
    op: 'local',
    payload: { method, args },
  });
  if (!answer?.ok) throw new Error(answer?.error ?? 'The extension did not answer.');
  return answer.result as T;
}

const notHere = (what: string) => () => Promise.reject(new Error(`${what} is in the Veil app.`));

export const localBackend: Backend = {
  capabilities: {
    nameDetection: false,
    pdf: false,
    desktopApps: false,
    apiEndpoints: false,
    diagnostics: false,
    appSettings: false,
    vaultStorage: false,
    license: false,
    customRules: false,
  },
  status: () => call('status'),
  config: () => call('config'),
  patchConfig: (patch) => call('patchConfig', patch),
  rules: () => call('rules'),
  putRules: (rules) => call('putRules', rules),
  importRules: notHere('Importing rules'),
  importDictionary: notHere('The custom dictionary'),
  async exportRules() {
    return JSON.stringify((await call<RulesView>('rules')).rules, null, 2);
  },
  testRules: (req) => call('testRules', req),
  activity: () => call('activity'),
  activityCsv: async () => {
    const rows = await call<{ at_ms: number; provider: string; route: string; outcome: string; restored: number; redacted: Record<string, number> }[]>('activity');
    const lines = rows.map((r) => [new Date(r.at_ms).toISOString(), r.provider, r.route, r.outcome, Object.values(r.redacted).reduce((a, b) => a + b, 0), r.restored].join(','));
    return ['time,site,route,outcome,redacted,restored', ...lines].join('\n');
  },
  recentMatches: () => call('recentMatches'),
  clearVault: () => call('clearVault'),
  setRunning: (running) => call('setRunning', running),
  diagnostics: notHere('Diagnostics'),
  license: notHere('The license'),
  setLicense: notHere('The license'),
  removeLicense: notHere('The license'),
  docs: notHere('Reading PDFs'),
  docsDownload: notHere('Reading PDFs'),
  docsRemove: notHere('Reading PDFs'),
  docsRead: notHere('Reading PDFs'),
  ner: notHere('Name detection'),
  nerDownload: notHere('Name detection'),
  nerRemove: notHere('Name detection'),

  onStatus(listener, onError) {
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        try {
          listener(await call('status'));
        } catch (e) {
          onError(e);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void poll();
    return () => {
      stopped = true;
    };
  },
  onConfigChanged: () => () => {},

  async copyText(text) {
    await navigator.clipboard.writeText(text);
  },
  async saveText(name, text, mime = 'text/plain') {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },
  openExternal: () => false,
  link: (screen: ScreenName) => `#/${screen}`,
};

/** What the page asks of the built-in engine beyond the screens. */
export const engine = {
  forgetValues: () => call<void>('clearVault'),
  enabled: () => call<boolean>('enabled'),
  setEnabled: (on: boolean) => call<void>('setEnabled', on),
  deleteEverything: () => call<void>('deleteEverything'),
};
