// Documents the user attaches. A file of a type Veil reads (from Veil's
// status, so new types need no change here) is sent to Veil before the site
// sees it; Veil returns its redacted text, and the page gets a text file
// with that text instead. The site uploads it as it uploads any file, so
// this doesn't depend on how each site uploads.
//
// `catch.ts` takes the files from the page's file pickers, drops and pastes.
// The guard here stops an upload of a document that didn't come through
// Veil, whichever way the site got hold of it.

import type { Channel } from './intercept';
import { failureMessage } from './intercept';
import type { DocDecision, DocFormat, DocumentsView, Failure, Site } from './protocol';
import { toBase64 } from './protocol';

/**
 * Used until Veil has answered, and when it can't be asked, so documents
 * are still caught (and then blocked) while Veil is not running. Veil's own
 * list replaces it; the text types here are the common ones.
 */
const FALLBACK: DocumentsView = {
  enabled: true,
  max_mb: 25,
  formats: [
    { id: 'pdf', name: 'PDF', extensions: ['pdf'], mime_types: ['application/pdf'] },
    {
      id: 'text',
      name: 'Text',
      extensions: ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'log', 'sql', 'env', 'ini', 'conf', 'cfg', 'properties', 'js', 'ts', 'py', 'java', 'go', 'rs', 'rb', 'php', 'cs', 'c', 'cpp', 'h', 'sh'],
      mime_types: ['text/plain', 'text/markdown', 'text/csv', 'application/json'],
      guard: false,
    },
  ],
};

const MB = 1024 * 1024;

export interface Notices {
  /** Something the user should know, that isn't a problem. */
  info(message: string): void;
  /** A file was stopped. */
  blocked(message: string): void;
}

/**
 * The type Veil lists that `file` is, by its extension or its media type.
 * A name that starts with a dot also counts its first part, so `.env.local`
 * is an `env` file.
 */
export function formatOf(file: Blob, view: DocumentsView): DocFormat | undefined {
  const name = file instanceof File ? file.name.toLowerCase() : '';
  const exts: string[] = [];
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) exts.push(name.slice(dot + 1));
  if (name.startsWith('.')) exts.push(name.slice(1).split('.')[0]);
  const type = file.type.toLowerCase();
  return view.formats.find(
    (f: DocFormat) => exts.some((e) => e && f.extensions.includes(e)) || (type && f.mime_types.includes(type)),
  );
}

export function isDocument(file: Blob, view: DocumentsView): boolean {
  return formatOf(file, view) !== undefined;
}

export function documentFailure(error: Failure, name: string): string {
  return failureMessage(error).replace('this message was not sent', `${name} was not attached`);
}

function newDraft(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Documents {
  /** Text files Veil made. */
  private made = new WeakSet<Blob>();
  /** Files Veil has seen: made, or let through as they were. */
  private cleared = new WeakSet<Blob>();
  private uploadedMade = new WeakSet<Blob>();
  private view: DocumentsView | undefined;
  private draft = newDraft();
  private draftPath: string;
  /** Documents were redacted under the draft on this page. */
  private pending = false;
  /** Veil's files uploaded since the last send. */
  private uploads = 0;

  constructor(
    private site: Site,
    private channel: Channel,
    private notices: Notices,
    /** The types Veil reads, as its status said at page load. */
    status: Promise<DocumentsView | undefined>,
    private path: () => string = () => location.pathname,
  ) {
    this.draftPath = path();
    void status.then((v) => {
      if (v) this.view = v;
    });
  }

  /** The types to catch: Veil's, or the fallback until Veil answers. */
  formats(): DocumentsView {
    return this.view ?? FALLBACK;
  }

  /** Asks Veil again if it didn't answer at page load. */
  private async refresh(): Promise<DocumentsView> {
    if (!this.view) {
      const answer = await this.channel.ask<{ documents?: DocumentsView }>('status', undefined);
      if (answer.ok && answer.result.documents) this.view = answer.result.documents;
    }
    return this.formats();
  }

  /** A new address is a different chat: start a new draft. */
  private follow(): void {
    const path = this.path();
    if (path === this.draftPath) return;
    this.draftPath = path;
    this.draft = newDraft();
    this.pending = false;
    this.uploads = 0;
  }

  /**
   * True if a drag carries a document. Only the files' types can be read
   * until they are dropped.
   */
  dragging(items: DataTransferItemList | undefined): boolean {
    if (!items) return false;
    const view = this.formats();
    for (const item of items) {
      if (item.kind === 'file' && view.formats.some((f) => f.mime_types.includes(item.type.toLowerCase()))) return true;
    }
    return false;
  }

  /** True if any of `files` is a document Veil should see. */
  wants(files: Iterable<File>): boolean {
    const view = this.formats();
    for (const f of files) if (!this.cleared.has(f) && isDocument(f, view)) return true;
    return false;
  }

  /**
   * The files to attach in place of `files`: documents become Veil's text
   * files, or are left out when Veil says so. Other files are kept.
   */
  async transform(files: File[]): Promise<File[]> {
    const view = await this.refresh();
    this.follow();
    const out: File[] = [];
    for (const file of files) {
      if (this.cleared.has(file) || !isDocument(file, view)) {
        out.push(file);
        continue;
      }
      const replaced = await this.one(file, view);
      if (replaced) out.push(replaced);
    }
    return out;
  }

  private async one(file: File, view: DocumentsView): Promise<File | null> {
    this.notices.info(`Reading ${file.name}…`);
    const fits = file.size <= view.max_mb * MB;
    const data = fits ? toBase64(new Uint8Array(await file.arrayBuffer())) : undefined;
    const answer = await this.channel.ask<DocDecision>('document', {
      site: this.site,
      page: this.path(),
      draft: this.draft,
      name: file.name,
      size: file.size,
      data,
    });
    if (!answer.ok) {
      if (await this.channel.allowUnprotected()) {
        this.cleared.add(file);
        return file;
      }
      this.notices.blocked(documentFailure(answer.error, file.name));
      return null;
    }
    const d = answer.result;
    if (d.action === 'block') {
      this.notices.blocked(d.message ?? `Veil stopped ${file.name}.`);
      return null;
    }
    if (d.action === 'pass' || d.text === undefined) {
      // Veil couldn't read it, and its settings let it through anyway.
      if (d.message) this.notices.blocked(d.message);
      this.cleared.add(file);
      return file;
    }
    const made = new File([d.text], d.name ?? `${file.name}.md`, { type: d.mime ?? 'text/plain', lastModified: Date.now() });
    this.made.add(made);
    this.cleared.add(made);
    this.pending = true;
    if (d.redacted > 0) this.channel.counted(d.redacted);
    const hidden = d.redacted === 1 ? '1 value hidden' : `${d.redacted} values hidden`;
    this.notices.info(`${file.name} is attached as redacted text (${hidden}).`);
    return made;
  }

  /** What a send tells Veil about the documents attached before it. */
  context(): { draft?: string; veil_files?: number } {
    this.follow();
    const out: { draft?: string; veil_files?: number } = {};
    if (this.pending) out.draft = this.draft;
    if (this.uploads > 0) out.veil_files = this.uploads;
    return out;
  }

  /** A send went out: the files uploaded so far belong to it. */
  sent(): void {
    this.uploads = 0;
  }

  /**
   * Checks a request body before it leaves. Returns the name of a document
   * Veil hasn't seen, which must not be uploaded, or null. Veil's own files
   * are counted for the next send.
   */
  inspect(body: unknown): string | null {
    const files: Blob[] = [];
    if (body instanceof Blob) files.push(body);
    else if (typeof FormData !== 'undefined' && body instanceof FormData) {
      for (const v of body.values()) if (v instanceof Blob) files.push(v);
    }
    const view = this.formats();
    for (const f of files) {
      if (this.made.has(f)) {
        if (!this.uploadedMade.has(f)) {
          this.uploadedMade.add(f);
          this.uploads++;
        }
        continue;
      }
      if (this.cleared.has(f)) continue;
      const format = formatOf(f, view);
      if (format && format.guard !== false) return f instanceof File ? f.name : 'a document';
    }
    return null;
  }

  unchecked(name: string): string {
    return `${name} was not uploaded, because Veil didn't check it first. Attach it again.`;
  }
}

/** The page's `fetch`, refusing uploads of documents Veil hasn't seen. */
export function guardFetch(inner: typeof fetch, docs: Documents, notices: Notices, allow: () => Promise<boolean>): typeof fetch {
  return async function veilGuard(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const name = docs.inspect(init?.body);
    if (name && !(await allow())) {
      notices.blocked(docs.unchecked(name));
      throw new TypeError('Failed to fetch');
    }
    return inner.call(this, input, init);
  };
}

/** The same for `XMLHttpRequest`, which many sites upload files with. */
export function guardXhr(proto: XMLHttpRequest, docs: Documents, notices: Notices, allowed: () => boolean): void {
  const realSend = proto.send;
  proto.send = function veilSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const name = docs.inspect(body);
    if (name && !allowed()) {
      notices.blocked(docs.unchecked(name));
      // As a network error would: the request never leaves.
      queueMicrotask(() => {
        this.dispatchEvent(new ProgressEvent('error'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      });
      return;
    }
    return realSend.call(this, body);
  };
}
