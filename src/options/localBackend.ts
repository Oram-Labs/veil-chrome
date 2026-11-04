// The settings screens' host: the built-in engine in the service worker,
// reached with messages. The screens are the Veil app's (veil-ui).

import type { Backend, DictionaryImport, DictionaryImportResult, RulesFile, RulesView, ScreenName } from 'veil-ui';

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const answer: { ok: boolean; result?: T; error?: string } | undefined = await chrome.runtime.sendMessage({
    op: 'local',
    payload: { method, args },
  });
  if (!answer?.ok) throw new Error(answer?.error ?? 'The extension did not answer.');
  return answer.result as T;
}

const notHere = (what: string) => () => Promise.reject(new Error(`${what} is in the Veil app.`));

/** Terms from a list: one per line, or CSV with the term first and its type second. */
function terms(text: string, format: DictionaryImport['format'], type: string): { term: string; type: string }[] {
  if (format === 'yaml') throw new Error('Import a plain list (one term per line) or a CSV file.');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      if (format !== 'csv') return { term: line, type };
      const [term = '', kind] = line.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, ''));
      return { term, type: kind || type };
    })
    .filter((e) => e.term);
}

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
  },
  status: () => call('status'),
  config: () => call('config'),
  patchConfig: (patch) => call('patchConfig', patch),
  rules: () => call('rules'),
  putRules: (rules) => call('putRules', rules),
  async importRules(text: string, replace: boolean): Promise<RulesView> {
    let incoming: RulesFile;
    try {
      incoming = JSON.parse(text) as RulesFile;
    } catch {
      throw new Error('Only a rules file saved as JSON can be imported here.');
    }
    if (replace) return call('putRules', incoming);
    const current = (await call<RulesView>('rules')).rules;
    return call('putRules', {
      ...current,
      dictionary: [...current.dictionary, ...(incoming.dictionary ?? [])],
      regex: [...current.regex, ...(incoming.regex ?? [])],
      allowlist: [...new Set([...current.allowlist, ...(incoming.allowlist ?? [])])],
    });
  },
  async importDictionary(req: DictionaryImport): Promise<DictionaryImportResult> {
    const current = (await call<RulesView>('rules')).rules;
    const base = req.replace ? [] : current.dictionary;
    const have = new Set(base.map((e) => `${e.match_case ? e.term : e.term.toLowerCase()}|${e.type}`));
    let added = 0;
    let skipped = 0;
    const dictionary = [...base];
    for (const { term, type } of terms(req.text, req.format, req.type)) {
      const key = `${req.match_case ? term : term.toLowerCase()}|${type.toUpperCase()}`;
      if (have.has(key)) {
        skipped++;
        continue;
      }
      have.add(key);
      dictionary.push({ term, type: type.toUpperCase(), match_case: req.match_case });
      added++;
    }
    return { rules: await call<RulesView>('putRules', { ...current, dictionary }), added, skipped };
  },
  async exportRules() {
    // JSON is YAML too, so the Veil app reads this file as it is.
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
  enabled: () => call<boolean>('enabled'),
  setEnabled: (on: boolean) => call<void>('setEnabled', on),
  deleteEverything: () => call<void>('deleteEverything'),
};
