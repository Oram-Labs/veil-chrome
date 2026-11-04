// Which engine answers: the Veil app, or the extension's built-in engine.
//
// The app comes first, whenever it can be reached. Only when it can't (not
// installed, not running) and the person has the built-in engine ready (a
// license key saved, and not turned off) does the built-in engine answer. A
// chat stays with the engine that started it, because only that one knows
// what its placeholders stand for; if that engine isn't there later, the
// message waits (is blocked) instead of going to the other one, whose
// placeholders would mean something else.

import type { Answer, Op, Site } from './protocol';

export type Engine = 'app' | 'local';

/** What answers operations. */
export interface Link {
  ask<T = unknown>(op: Op, payload?: unknown): Promise<Answer<T>>;
}

/** The built-in engine, as the router needs it. */
export interface LocalLink extends Link {
  available(): Promise<boolean>;
}

/** Which engine each chat uses, kept in the browser. */
export interface Pins {
  get(key: string): Promise<Engine | undefined>;
  set(key: string, engine: Engine): Promise<void>;
}

export interface Context {
  /** The page that asked, from the tab. */
  tabUrl?: string;
  tabId?: number;
}

export interface Router {
  route(op: Op, payload: unknown, ctx: Context): Promise<Answer>;
}

/** Why the app couldn't answer: not that it said no, but that nobody was there. */
const UNREACHABLE = new Set(['no_host', 'not_running', 'host_exited']);

export function appUnreachable(answer: Answer): boolean {
  return !answer.ok && UNREACHABLE.has(answer.error);
}

/** A reply ticket made by the built-in engine starts with this, so its chunks come back to it. */
const LOCAL_TICKET = 'local:';

/** How long a new chat's engine is remembered for the tab, until its address names it. */
const NEW_CHAT_MS = 10 * 60 * 1000;

/** The chat the page shows, from its address: `site:id`, or null for a chat that hasn't started. */
export function chatKey(url: string | undefined, site: Site | null): string | null {
  if (!url || !site) return null;
  try {
    return chatKeyOf(new URL(url).pathname, site);
  } catch {
    return null;
  }
}

/** The same, from the page's path. */
function chatKeyOf(path: string, site: Site): string | null {
  const segments = path.split('/').filter(Boolean);
  const after = (marker: string) => {
    const i = segments.indexOf(marker);
    const id = i >= 0 ? segments[i + 1] : undefined;
    return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
  };
  const id = site === 'claude.ai' ? after('chat') : after('c');
  return id ? `${site}:${id}` : null;
}

/** The same, from the `page` or `conversation` a payload carries. */
function payloadChat(site: Site | null, payload: unknown): string | null {
  const p = (payload ?? {}) as { page?: string; conversation?: string };
  if (typeof p.conversation === 'string' && site && /^[A-Za-z0-9_-]{1,64}$/.test(p.conversation)) return `${site}:${p.conversation}`;
  if (typeof p.page === 'string' && site) return chatKeyOf(p.page.split(/[?#]/)[0] ?? '', site);
  return null;
}

const blocked = (message: string) => ({ ok: true as const, result: { action: 'block', message, redacted: 0 } });

export function makeRouter(app: Link, local: LocalLink, pins: Pins, now: () => number = Date.now): Router {
  /** New chats: the engine of the tab's last first message, until the chat has an address. */
  const fresh = new Map<number, { engine: Engine; at: number }>();

  async function pinned(site: Site | null, payload: unknown, ctx: Context): Promise<Engine | undefined> {
    const keys = [chatKey(ctx.tabUrl, site), payloadChat(site, payload), draftKey(site, payload)].filter((k): k is string => k !== null);
    for (const key of keys) {
      const engine = await pins.get(key);
      if (engine) return engine;
    }
    // A chat that just started: its address now names it, and the tab remembers who started it.
    const chat = chatKey(ctx.tabUrl, site);
    const start = ctx.tabId === undefined ? undefined : fresh.get(ctx.tabId);
    if (chat && start && now() - start.at < NEW_CHAT_MS) {
      fresh.delete(ctx.tabId!);
      await pins.set(chat, start.engine);
      return start.engine;
    }
    return undefined;
  }

  async function pin(site: Site | null, payload: unknown, ctx: Context, engine: Engine): Promise<void> {
    const keys = [chatKey(ctx.tabUrl, site), payloadChat(site, payload), draftKey(site, payload)].filter((k): k is string => k !== null);
    for (const key of keys) await pins.set(key, engine);
    if (!chatKey(ctx.tabUrl, site) && ctx.tabId !== undefined) fresh.set(ctx.tabId, { engine, at: now() });
  }

  /** Sends go to the chat's engine, or to the app and then the built-in engine. */
  async function send(op: 'request' | 'document', payload: unknown, ctx: Context): Promise<Answer> {
    const site = (payload as { site?: Site } | undefined)?.site ?? null;
    const engine = await pinned(site, payload, ctx);
    // Only a message or file that was changed ties the chat to an engine: one
    // sent as it was holds no placeholders for the other engine to mean differently.
    const handled = (answer: Answer) => {
      const action = answer.ok ? (answer.result as { action?: string }).action : undefined;
      return action === 'rewrite' || action === 'replace';
    };
    if (engine === 'local') {
      if (!(await local.available())) return blocked('This chat was started with the extension\'s built-in engine, which needs your license key. Enter it in the extension\'s settings.');
      return withTicket(await local.ask(op, payload));
    }
    if (engine === 'app') {
      const answer = await app.ask(op, payload);
      if (appUnreachable(answer)) return blocked('This chat was started with the Veil app. Open Veil to keep using it.');
      return answer;
    }
    const answer = await app.ask(op, payload);
    if (answer.ok) {
      if (handled(answer)) await pin(site, payload, ctx, 'app');
      return answer;
    }
    if (appUnreachable(answer) && (await local.available())) {
      const l = withTicket(await local.ask(op, payload));
      if (handled(l)) await pin(site, payload, ctx, 'local');
      return l;
    }
    return answer;
  }

  return {
    async route(op, payload, ctx) {
      switch (op) {
        case 'status': {
          const answer = await app.ask('status', payload);
          if (appUnreachable(answer) && (await local.available())) {
            const l = await local.ask<Record<string, unknown>>('status', payload);
            return l.ok ? { ok: true, result: { ...l.result, engine: 'builtin' } } : l;
          }
          return answer;
        }
        case 'request':
        case 'document':
          return send(op, payload, ctx);
        case 'response': {
          const ticket = String((payload as { ticket?: string } | undefined)?.ticket ?? '');
          if (ticket.startsWith(LOCAL_TICKET)) {
            return local.ask('response', { ...(payload as object), ticket: ticket.slice(LOCAL_TICKET.length) });
          }
          return app.ask('response', payload);
        }
        case 'page_data': {
          const site = ((payload as { site?: Site })?.site ?? null) as Site | null;
          const engine = await pinned(site, payload, ctx);
          if (engine === 'local') return (await local.available()) ? local.ask(op, payload) : { ok: false, error: 'no_local' };
          if (engine === 'app') return app.ask(op, payload);
          const answer = await app.ask(op, payload);
          if (appUnreachable(answer) && (await local.available())) return local.ask(op, payload);
          return answer;
        }
        case 'observe': {
          const answer = await app.ask(op, payload);
          return appUnreachable(answer) ? { ok: true, result: { written: false } } : answer;
        }
        case 'open':
          return app.ask(op, payload);
      }
    },
  };
}

/** The built-in engine's tickets are marked, so the reply finds its way back to it. */
function withTicket(answer: Answer): Answer {
  if (answer.ok && typeof (answer.result as { ticket?: unknown }).ticket === 'string') {
    const result = answer.result as { ticket: string };
    return { ok: true, result: { ...result, ticket: LOCAL_TICKET + result.ticket } };
  }
  return answer;
}

/** The draft a new chat's documents were redacted under, which its first message carries. */
function draftKey(site: Site | null, payload: unknown): string | null {
  const draft = (payload as { draft?: string } | undefined)?.draft;
  return site && typeof draft === 'string' && draft.length > 0 && draft.length <= 128 ? `${site}:draft:${draft}` : null;
}
