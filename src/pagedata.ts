// Chat data built into the page. On a full reload chatgpt.com sends the open
// chat inside the HTML: one script creates `window.__reactRouterContext` and
// a stream whose controller it keeps as `streamController`, and later scripts
// call `streamController.enqueue("…")` with the data. Nothing of this goes
// through `fetch`, so without this the page shows placeholders after a
// reload. (Seen in captures of chatgpt.com, Oct 2026.)
//
// This runs before the site's scripts and puts a stand-in controller in
// place. Each chunk goes through Veil first, which restores it with the
// values of the chat in the address bar; chunks keep their order, and the
// page's own reader just waits a moment longer.

/** Restores one chunk, or returns null to keep it as it is. */
export type RestoreChunk = (text: string) => Promise<string | null>;

/** The id of the chat in a chatgpt.com address: `/c/<id>`, also under `/g/<gpt>/`. */
export function conversationFromPath(path: string): string | null {
  const m = path.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i);
  return m ? m[1] : null;
}

/** Wraps a stream controller so chunks are restored, in order, before they reach the stream. */
export function restoringController(
  real: ReadableStreamDefaultController<string>,
  restore: RestoreChunk,
): ReadableStreamDefaultController<string> {
  let chain: Promise<unknown> = Promise.resolve();
  const later = (step: () => unknown | Promise<unknown>) => {
    chain = chain.then(step).catch(() => undefined);
  };
  return {
    get desiredSize() {
      return real.desiredSize;
    },
    enqueue(chunk?: string) {
      // Ask now, so chunks are restored in parallel but delivered in order.
      const restored = typeof chunk === 'string' && chunk.length > 0 ? restore(chunk).catch(() => null) : Promise.resolve(null);
      later(async () => real.enqueue((await restored) ?? (chunk as string)));
    },
    close() {
      later(() => real.close());
    },
    error(reason?: unknown) {
      later(() => real.error(reason));
    },
  } as ReadableStreamDefaultController<string>;
}

/**
 * Catches `__reactRouterContext.streamController` as the page sets it and
 * swaps in a restoring controller. Does nothing on pages without a chat id.
 */
export function hookPageData(win: Window, restore: (text: string, conversation: string) => Promise<string | null>): void {
  const conversation = conversationFromPath(win.location.pathname);
  if (!conversation) return;
  const target = win as unknown as Record<string, unknown>;
  let context: unknown = target.__reactRouterContext;
  const wrap = (ctx: unknown) => {
    if (!ctx || typeof ctx !== 'object') return;
    const holder = ctx as Record<string, unknown>;
    let controller = holder.streamController as ReadableStreamDefaultController<string> | undefined;
    if (controller) controller = restoringController(controller, (t) => restore(t, conversation));
    Object.defineProperty(holder, 'streamController', {
      configurable: true,
      enumerable: true,
      get: () => controller,
      set: (c: ReadableStreamDefaultController<string>) => {
        controller = c ? restoringController(c, (t) => restore(t, conversation)) : c;
      },
    });
  };
  wrap(context);
  Object.defineProperty(target, '__reactRouterContext', {
    configurable: true,
    enumerable: true,
    get: () => context,
    set: (value: unknown) => {
      context = value;
      wrap(value);
    },
  });
}
