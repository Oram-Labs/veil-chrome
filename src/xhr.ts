// Gemini sends its chats by XMLHttpRequest (Google WebChannel), not fetch.
// The extension can only wait for Veil, and pass a reply through it piece by
// piece, with fetch: an XHR's `send()` can't wait, and the page reads its
// `responseText` itself. So on Gemini, `XMLHttpRequest` becomes a subclass
// that, for the chat's address only, does the request with the wrapped
// fetch (through Veil, as on the other sites) and plays the XHR's part to
// the page: its states, events and `responseText`. Every other XHR is the
// browser's own, untouched.

/** What the page sees: an XMLHttpRequest. */
type XhrClass = typeof XMLHttpRequest;

const DONE = 4;

function event(type: string, loaded = 0): Event {
  return typeof ProgressEvent === 'function' ? new ProgressEvent(type, { lengthComputable: false, loaded }) : new Event(type);
}

/** One request to the chat's address, done with fetch. */
class Stand {
  readyState = 1; // OPENED
  status = 0;
  statusText = '';
  text = '';
  url = '';
  headers = new Headers();
  sent = false;
  private requestHeaders = new Headers();
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Why it ended early, if it did: what `abort()` and the timeout leave behind. */
  private ended: 'abort' | 'timeout' | null = null;

  constructor(
    private xhr: XMLHttpRequest,
    private method: string,
    private target: URL,
    private fetchFn: typeof fetch,
  ) {}

  private set(state: number): void {
    this.readyState = state;
    this.xhr.dispatchEvent(new Event('readystatechange'));
  }

  header(name: string, value: string): void {
    if (this.readyState !== 1 || this.sent) throw new DOMException('The object is in an invalid state.', 'InvalidStateError');
    this.requestHeaders.append(name, value);
  }

  send(body: unknown, withCredentials: boolean, timeout: number): void {
    if (this.readyState !== 1 || this.sent) throw new DOMException('The object is in an invalid state.', 'InvalidStateError');
    this.sent = true;
    const init: RequestInit = {
      method: this.method,
      headers: this.requestHeaders,
      credentials: withCredentials ? 'include' : 'same-origin',
      mode: 'cors',
      signal: this.controller.signal,
    };
    if (this.method !== 'GET' && this.method !== 'HEAD' && body != null) init.body = body as BodyInit;
    if (timeout > 0) {
      this.timer = setTimeout(() => this.stop('timeout'), timeout);
    }
    queueMicrotask(() => this.xhr.dispatchEvent(event('loadstart')));
    void this.run(init);
  }

  private async run(init: RequestInit): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchFn.call(globalThis, this.target.href, init);
    } catch {
      return this.fail();
    }
    if (this.ended) return;
    this.status = response.status;
    this.statusText = response.statusText;
    this.headers = response.headers;
    this.url = response.url || this.target.href;
    this.set(2); // HEADERS_RECEIVED
    const decoder = new TextDecoder();
    let loaded = 0;
    try {
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (this.ended) return;
          if (done) break;
          if (!value || value.length === 0) continue;
          loaded += value.length;
          this.text += decoder.decode(value, { stream: true });
          // Each piece: the page reads the stream as it grows.
          this.set(3); // LOADING
          this.xhr.dispatchEvent(event('progress', loaded));
        }
      }
      this.text += decoder.decode();
    } catch {
      if (this.ended) return;
      return this.fail();
    }
    clearTimeout(this.timer);
    this.set(DONE);
    this.xhr.dispatchEvent(event('load', loaded));
    this.xhr.dispatchEvent(event('loadend', loaded));
  }

  /** A network error, as the browser reports one. */
  private fail(): void {
    if (this.ended) return;
    clearTimeout(this.timer);
    this.status = 0;
    this.statusText = '';
    this.text = '';
    this.headers = new Headers();
    this.set(DONE);
    this.xhr.dispatchEvent(event('error'));
    this.xhr.dispatchEvent(event('loadend'));
  }

  private stop(why: 'abort' | 'timeout'): void {
    if (this.ended || this.readyState === DONE) return;
    this.ended = why;
    clearTimeout(this.timer);
    this.controller.abort();
    this.status = 0;
    this.statusText = '';
    this.text = '';
    this.set(DONE);
    this.xhr.dispatchEvent(event(why));
    this.xhr.dispatchEvent(event('loadend'));
  }

  abort(): void {
    if (this.sent && this.readyState !== DONE) this.stop('abort');
    // After an abort the request is unsent again, without an event.
    this.readyState = 0;
  }

  responseHeader(name: string): string | null {
    return this.readyState >= 2 ? this.headers.get(name) : null;
  }

  allHeaders(): string {
    if (this.readyState < 2) return '';
    let out = '';
    this.headers.forEach((value, name) => (out += `${name.toLowerCase()}: ${value}\r\n`));
    return out;
  }
}

/**
 * `XMLHttpRequest` with the requests `isChat` picks done through `fetchFn`.
 * `base` is the page's address, for relative URLs.
 */
export function chatXhr(Real: XhrClass, fetchFn: typeof fetch, isChat: (url: URL) => boolean, base: () => string): XhrClass {
  class XMLHttpRequest extends Real {
    #stand: Stand | null = null;
    #timeout = 0;

    override open(method: string, url: string | URL, async?: boolean, user?: string | null, password?: string | null): void {
      let target: URL | null = null;
      try {
        target = new URL(String(url), base());
      } catch {
        target = null;
      }
      // Only asynchronous requests: a page can't stream a synchronous one anyway.
      if (target && isChat(target) && async !== false && !user && !password) {
        this.#stand?.abort();
        this.#stand = new Stand(this, method.toUpperCase(), target, fetchFn);
        this.dispatchEvent(new Event('readystatechange'));
        return;
      }
      this.#stand = null;
      // Called with as many arguments as the page gave.
      return (super.open as (...a: unknown[]) => void).apply(this, [...arguments]);
    }

    override setRequestHeader(name: string, value: string): void {
      if (this.#stand) return this.#stand.header(name, value);
      return super.setRequestHeader(name, value);
    }

    override send(body?: Document | XMLHttpRequestBodyInit | null): void {
      const stand = this.#stand;
      if (!stand) return super.send(body);
      const type = this.responseType;
      if (type !== '' && type !== 'text') {
        // Not text: the stand-in can't play this part; Veil can't restore it either.
        throw new DOMException(`Veil can't pass a "${type}" reply on this site.`, 'NotSupportedError');
      }
      stand.send(body, this.withCredentials, this.#timeout);
    }

    override abort(): void {
      if (this.#stand) return this.#stand.abort();
      return super.abort();
    }

    override getResponseHeader(name: string): string | null {
      return this.#stand ? this.#stand.responseHeader(name) : super.getResponseHeader(name);
    }

    override getAllResponseHeaders(): string {
      return this.#stand ? this.#stand.allHeaders() : super.getAllResponseHeaders();
    }

    override overrideMimeType(mime: string): void {
      if (!this.#stand) super.overrideMimeType(mime);
    }

    override get readyState(): number {
      return this.#stand ? this.#stand.readyState : super.readyState;
    }

    override get status(): number {
      return this.#stand ? this.#stand.status : super.status;
    }

    override get statusText(): string {
      return this.#stand ? this.#stand.statusText : super.statusText;
    }

    override get responseText(): string {
      return this.#stand ? this.#stand.text : super.responseText;
    }

    override get response(): unknown {
      return this.#stand ? this.#stand.text : super.response;
    }

    override get responseURL(): string {
      return this.#stand ? this.#stand.url : super.responseURL;
    }

    override get responseXML(): Document | null {
      return this.#stand ? null : super.responseXML;
    }

    override get timeout(): number {
      return this.#timeout;
    }

    override set timeout(ms: number) {
      this.#timeout = ms;
      super.timeout = ms;
    }
  }
  // Keep the name and `toString()` looking native; some sites check.
  Object.defineProperty(XMLHttpRequest, 'name', { value: 'XMLHttpRequest' });
  Object.defineProperty(XMLHttpRequest, 'toString', { value: () => 'function XMLHttpRequest() { [native code] }' });
  return XMLHttpRequest;
}
