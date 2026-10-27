// The page's `fetch`, wrapped. A request that may carry chat text goes to
// Veil first; Veil returns it redacted (or says to block it), and the reply
// is passed through Veil as it streams in, so the page shows real values.
//
// The text box keeps what the user typed. Only the network request changes,
// so this keeps working when the sites change their editors.

import { interesting, sends } from './sites';
import type { Answer, ChunkOut, Decision, Failure, Op, Site } from './protocol';
import { fromBase64, toBase64 } from './protocol';

export interface Channel {
  ask<T>(op: Op, payload: unknown): Promise<Answer<T>>;
  /** Whether the user lets sends through when Veil can't be reached. */
  allowUnprotected(): Promise<boolean>;
  /** A send was stopped; tell the user why. */
  blocked(message: string): void;
  /** Values replaced in a send. */
  counted(n: number): void;
  /** What a send tells Veil about documents attached before it. */
  attached?(): { draft?: string; veil_files?: number };
  /** A send went out to the site. */
  sent?(): void;
}

/** Reply chunks sent to Veil are at most this long. */
const PIECE = 256 * 1024;

export function failureMessage(error: Failure): string {
  switch (error) {
    case 'no_host':
      return "Veil isn't installed, or hasn't been opened yet, so this message was not sent. Install the Veil app, open it once, then try again.";
    case 'not_running':
      return "Veil isn't running, so this message was not sent. Open Veil and try again.";
    case 'timeout':
      return "Veil didn't answer in time, so this message was not sent. Try again.";
    default:
      return "Veil couldn't check this message, so it was not sent. Open Veil to see what's wrong.";
  }
}

export function blockedResponse(message: string): Response {
  const body = JSON.stringify({ error: { type: 'veil_blocked', message }, detail: message });
  return new Response(body, { status: 403, statusText: 'Blocked by Veil', headers: { 'content-type': 'application/json' } });
}

function target(input: RequestInfo | URL, init: RequestInit | undefined, base: string): { method: string; url: URL } {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return { method: (init?.method ?? input.method).toUpperCase(), url: new URL(input.url, base) };
  }
  return { method: (init?.method ?? 'GET').toUpperCase(), url: new URL(String(input), base) };
}

export function wrapFetch(
  realFetch: typeof fetch,
  site: Site,
  channel: Channel,
  base: () => string = () => location.href,
): typeof fetch {
  return async function veilFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let method: string;
    let url: URL;
    try {
      ({ method, url } = target(input, init, base()));
    } catch {
      return realFetch.call(this, input, init);
    }
    const page = new URL(base());
    if (url.origin !== page.origin || !interesting(site, method, url.pathname)) {
      return realFetch.call(this, input, init);
    }
    const request = input instanceof Request ? new Request(input, init) : new Request(url.href, init);
    let body: Uint8Array | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      body = new Uint8Array(await request.clone().arrayBuffer());
    }
    const sending = sends(method, url.pathname);
    const answer = await channel.ask<Decision>('request', {
      site,
      method,
      path: url.pathname + url.search,
      body: body ? toBase64(body) : undefined,
      ...(sending ? channel.attached?.() : undefined),
    });
    if (!answer.ok) {
      if (!sending || (await channel.allowUnprotected())) {
        return realFetch.call(this, request);
      }
      const message = failureMessage(answer.error);
      channel.blocked(message);
      return blockedResponse(message);
    }
    const decision = answer.result;
    if (decision.action === 'block') {
      const message = decision.message ?? 'Veil stopped this message.';
      channel.blocked(message);
      return blockedResponse(message);
    }
    if (decision.redacted > 0) channel.counted(decision.redacted);
    const outgoing =
      decision.action === 'rewrite' && decision.body !== undefined
        ? new Request(request, { body: fromBase64(decision.body) as BodyInit })
        : request;
    const response = await realFetch.call(this, outgoing);
    if (sending) channel.sent?.();
    if (!decision.ticket || !response.body) return response;
    return restored(response, decision.ticket, channel);
  };
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name === 'AbortError' ? 'aborted_by_page' : `error: ${error.name}`;
  return 'error';
}

/** The reply, with each chunk passed through Veil before the page reads it. */
export function restored(response: Response, ticket: string, channel: Channel): Response {
  const reader = response.body!.getReader();
  const contentType = response.headers.get('content-type') ?? '';
  let first = true;
  // If Veil stops answering mid-reply, the rest goes to the page as it came.
  let broken = false;
  const send = async (piece: Uint8Array, done: boolean): Promise<Uint8Array> => {
    if (broken) return piece;
    const chunk: Record<string, unknown> = { ticket, chunk: toBase64(piece), done };
    if (first) {
      chunk.status = response.status;
      chunk.content_type = contentType;
      first = false;
    }
    const answer = await channel.ask<ChunkOut>('response', chunk);
    if (!answer.ok) {
      broken = true;
      return piece;
    }
    return fromBase64(answer.result.chunk);
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ value, done } = await reader.read());
      } catch (error) {
        // The reply broke off (the page aborted it, or the connection
        // dropped). Tell Veil it is over, so it is logged and captured.
        if (!broken) {
          broken = true;
          void channel.ask('response', { ticket, done: true, error: errorName(error) });
        }
        controller.error(error);
        return;
      }
      const pieces: Uint8Array[] = [];
      if (value) {
        for (let i = 0; i < value.length; i += PIECE) pieces.push(value.subarray(i, i + PIECE));
      }
      if (done) pieces.push(new Uint8Array(0));
      for (let i = 0; i < pieces.length; i++) {
        const out = await send(pieces[i], done && i === pieces.length - 1);
        if (out.length > 0) controller.enqueue(out);
      }
      if (done) controller.close();
    },
    async cancel(reason) {
      if (!broken) {
        broken = true;
        void channel.ask('response', { ticket, done: true, error: 'cancelled_by_page' });
      }
      await reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  const out = new Response(stream, { status: response.status, statusText: response.statusText, headers });
  // Some sites look at these.
  Object.defineProperty(out, 'url', { value: response.url });
  Object.defineProperty(out, 'redirected', { value: response.redirected });
  return out;
}
