// Takes documents from the page's file pickers, drops and pastes before the
// site's own code sees them. This runs in the capture phase on `window`,
// added before any site script, so it is the first listener. The event is
// stopped, the files go through Veil, and the same event is fired again
// with Veil's files in place of the documents.
//
// Reading takes a moment, and the page may have moved on by then: claude.ai
// takes files from an input inside a menu that closes once a file is
// picked. When the input is gone, and for drops, Veil's files go into the
// page's own file input if it keeps one (claude.ai does, and takes files
// set on it from a script), or are pasted into the chat box. claude.ai
// ignores files pasted from a script, so a paste the page doesn't take is
// reported, never assumed to have worked.

import type { Documents } from './documents';

/** Events fired by Veil, which go to the site untouched. */
const ours = new WeakSet<Event>();

/** How Veil's files reached the page, for capture. */
export type Delivered = (how: string, detail: Record<string, unknown>) => void;

function filesOf(list: FileList | null | undefined): File[] {
  return list ? [...list] : [];
}

function transfer(files: File[]): DataTransfer {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  return dt;
}

function editable(el: Element | null): el is HTMLElement {
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
}

/** The chat box: the focused editor, or the first one on the page. */
export function composer(doc: Document): HTMLElement | null {
  if (editable(doc.activeElement)) return doc.activeElement;
  const found = doc.querySelector('[contenteditable="true"], textarea');
  return found instanceof HTMLElement ? found : null;
}

/** Pastes `files` at `at`. True if the page took them (it cancels the paste). */
function paste(at: EventTarget, files: File[]): boolean {
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: transfer(files) });
  ours.add(event);
  return !at.dispatchEvent(event);
}

/** True if a file input's `accept` lets `file` in. */
function accepts(input: HTMLInputElement, file: File): boolean {
  const accept = input.accept.trim();
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept.split(',').some((raw) => {
    const a = raw.trim().toLowerCase();
    if (!a) return false;
    if (a.startsWith('.')) return name.endsWith(a);
    if (a.endsWith('/*')) return type.startsWith(a.slice(0, -1));
    return a === type;
  });
}

/**
 * The page's own file input that can take `files`: claude.ai's is marked
 * `file-upload`; otherwise the first enabled one that accepts them all.
 */
export function fileInput(doc: Document, files: File[]): HTMLInputElement | null {
  const all = [...doc.querySelectorAll('input[type="file"]')].filter(
    (i): i is HTMLInputElement =>
      i instanceof HTMLInputElement && !i.disabled && (files.length < 2 || i.multiple) && files.every((f) => accepts(i, f)),
  );
  return all.find((i) => i.dataset.testid === 'file-upload') ?? all[0] ?? null;
}

/** Sets `files` on a file input and tells the page, as a pick would. */
function fill(input: HTMLInputElement, files: File[]): void {
  input.files = transfer(files).files;
  for (const type of ['input', 'change']) {
    const again = new Event(type, { bubbles: true });
    ours.add(again);
    input.dispatchEvent(again);
  }
}

function connected(at: EventTarget | null): at is Node {
  return at instanceof Node && at.isConnected;
}

/**
 * Catches documents on `target`. `lost` is told the names of files Veil
 * made that the page didn't take, so the user can attach them again.
 */
export function catchFiles(
  target: Window,
  docs: Documents,
  delivered: Delivered = () => {},
  lost: (names: string[]) => void = () => {},
): void {
  const doc = target.document;

  /**
   * Hands Veil's files to the page when its own target is gone: through
   * its file input, or else pasted into the chat box.
   */
  const fallback = (files: File[], why: string) => {
    const input = fileInput(doc, files);
    if (input) {
      fill(input, files);
      delivered('file_input', { why, files: files.length });
      return;
    }
    const box = composer(doc);
    if (box) {
      box.focus();
      if (paste(box, files)) {
        delivered('pasted', { why, files: files.length, into: box.tagName.toLowerCase() });
        return;
      }
    }
    delivered('lost', { why, files: files.length, box: box !== null });
    lost(files.map((f) => f.name));
  };

  // A file input: `input` and then `change` fire once the user has picked.
  const picked = (event: Event) => {
    const input = event.target;
    if (ours.has(event) || !(input instanceof HTMLInputElement) || input.type !== 'file') return;
    const files = filesOf(input.files);
    if (!docs.wants(files)) return;
    event.stopImmediatePropagation();
    // Both events arrive for one pick; the files are handled once.
    if (event.type !== 'change') return;
    void docs.transform(files).then((out) => {
      if (out.length === 0) {
        input.value = '';
        return;
      }
      if (!input.isConnected) {
        fallback(out, 'input_removed');
        return;
      }
      fill(input, out);
      delivered('input', { files: out.length });
    });
  };
  target.addEventListener('input', picked, true);
  target.addEventListener('change', picked, true);

  // A drag that carries a document is hidden from the page: the site
  // never sees it, so it shows no "drop files here" overlay and has no drag
  // to end. The sites only take files from a real drop, so Veil can't hand
  // them a drop of its own; when the user lets go, Veil takes the files and
  // pastes them, documents redacted, into the chat box.
  const hide = (event: DragEvent) => {
    if (ours.has(event) || !docs.dragging(event.dataTransfer?.items)) return;
    event.stopImmediatePropagation();
    // Cancelling dragover is what lets the drop happen.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  for (const type of ['dragenter', 'dragover', 'dragleave'] as const) target.addEventListener(type, hide, true);

  target.addEventListener(
    'drop',
    (event: DragEvent) => {
      if (ours.has(event)) return;
      const files = filesOf(event.dataTransfer?.files);
      if (!docs.wants(files)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void docs.transform(files).then((out) => {
        if (out.length > 0) fallback(out, 'dropped');
      });
    },
    true,
  );

  target.addEventListener(
    'paste',
    (event: ClipboardEvent) => {
      if (ours.has(event)) return;
      const files = filesOf(event.clipboardData?.files);
      if (!docs.wants(files)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const at = event.composedPath()[0] ?? event.target;
      void docs.transform(files).then((out) => {
        if (out.length === 0) return;
        if (!connected(at) || !paste(at, out)) {
          fallback(out, connected(at) ? 'paste_ignored' : 'paste_target_removed');
          return;
        }
        delivered('paste', { files: out.length });
      });
    },
    true,
  );
}
