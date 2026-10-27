// Takes documents from the page's file pickers, drops and pastes before the
// site's own code sees them. This runs in the capture phase on `window`,
// added before any site script, so it is the first listener. The event is
// stopped, the files go through Veil, and the same event is fired again
// with Veil's files in place of the documents.
//
// Reading takes a moment, and the page may have moved on by then: claude.ai
// takes files from an input inside a menu that closes once a file is
// picked. When the input is gone, and for drops, Veil's files are pasted
// into the chat box instead, which both sites accept from a script.

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

function paste(at: EventTarget, files: File[]): boolean {
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: transfer(files) });
  ours.add(event);
  at.dispatchEvent(event);
  return true;
}

function connected(at: EventTarget | null): at is Node {
  return at instanceof Node && at.isConnected;
}

export function catchFiles(target: Window, docs: Documents, delivered: Delivered = () => {}): void {
  const doc = target.document;

  /** Pastes into the chat box when the page's own target is gone. */
  const fallback = (files: File[], why: string) => {
    const box = composer(doc);
    if (!box) {
      delivered('lost', { why, files: files.length });
      return;
    }
    box.focus();
    paste(box, files);
    delivered('pasted', { why, files: files.length, into: box.tagName.toLowerCase() });
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
      input.files = transfer(out).files;
      for (const type of ['input', 'change']) {
        const again = new Event(type, { bubbles: true });
        ours.add(again);
        input.dispatchEvent(again);
      }
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
        if (!connected(at)) {
          fallback(out, 'paste_target_removed');
          return;
        }
        paste(at, out);
        delivered('paste', { files: out.length });
      });
    },
    true,
  );
}
