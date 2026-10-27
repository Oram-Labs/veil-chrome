# Protocol: what the extension sends to the Veil app

The extension talks to one program only: the native messaging host `com.veil.app.native`, which the Veil app installs. Chrome starts the host and connects the extension to it over the host's standard input and output. The extension makes no network requests of its own.

This document is what that program receives. The Veil app's implementation is not open source; `e2e/mock-host.mjs` is a small stand-in that answers the same messages, for the tests.

## Connection

- **Who may connect.** The host's manifest, which the Veil app writes into Chrome's `NativeMessagingHosts` folder, lists the extensions allowed to start it: the Chrome Web Store's copy, `lanejpecogmomcibpjcomddmkgpagneb`, and unpacked builds, `kgkmpkkhpegbhjloakfcibgfgpmfdjil`, an ID fixed by the public key in `static/manifest.json`.
- **Framing.** Chrome's: each message is a 4-byte length in the machine's byte order, then that many bytes of UTF-8 JSON.
- **Long replies.** Chrome refuses messages from a host larger than 1 MB, so a longer reply comes in parts, `{"id": 1, "part": 0, "parts": 3, "data": "…"}`. The parts' `data`, joined in order, is the reply's JSON.

Every message from the extension is `{"id": <number>, "op": <operation>, "payload": <object>}`. Every reply is `{"id": <same number>, "ok": true, "result": <object>}` or `{"id": <same number>, "ok": false, "error": <reason>}`. Reasons include `not_running` (the app is installed but not running), `unauthorized`, `no_token`, `bad_message` and `unknown_op`. The extension treats a reply that doesn't come within 60 seconds as `timeout`, and a host it can't start as `no_host`.

Bodies and chunks are bytes, sent as base64.

## Operations

### `status`

Asked when a page on claude.ai or chatgpt.com loads, and by the popup. The payload says which version of the extension asks, `{"extension": "0.2.0"}`; the app shows it on its General screen and keeps nothing else from it.

```json
{ "version": "0.1.23", "running": true, "activated": true, "mode": "redact",
  "fail_closed": true, "sites": { "claude.ai": true, "chatgpt.com": true }, "capture": false }
```

`sites` says which sites Veil protects. `capture` is the app's "Capture traffic" setting (see `observe`).

### `request`

A request the page is about to send. Sent only for requests that match `src/sites.ts`: the ones that can carry chat text, or bring it back. Everything else on the page goes to the site without the extension touching it.

```json
{ "site": "chatgpt.com", "method": "POST", "path": "/backend-api/f/conversation", "body": "<base64>" }
```

`body` is absent for `GET`. The reply is a decision:

```json
{ "action": "rewrite", "body": "<base64>", "ticket": "…", "redacted": 2 }
```

| `action` | What the extension does |
|---|---|
| `pass` | Sends the request as the page made it |
| `rewrite` | Sends `body` instead: the request with sensitive values replaced by placeholders |
| `block` | Doesn't send it; shows `message` on the page and answers the page with HTTP 403 |

With a `ticket`, the site's reply goes back through Veil (`response`), so placeholders in it can be turned back into real values.

**If Veil can't be reached**, requests that send text (`src/sites.ts`, `sends`) are blocked, and the page says why, unless the user has turned on "send without protection" for that site in the popup. Requests that only read, such as loading a chat, go through unchanged.

### `response`

One chunk of the site's reply to a request that got a `ticket`, in order, as it arrives.

```json
{ "ticket": "…", "chunk": "<base64>", "done": false, "status": 200, "content_type": "text/event-stream" }
```

`status` and `content_type` come with the first chunk. The last call has `done: true`, and `error` if the reply broke off (for example `cancelled_by_page`). The reply is the bytes to give the page, with placeholders restored: `{"chunk": "<base64>"}`. It can be shorter than what was sent, when the end could be the start of a placeholder; the rest comes with a later chunk.

### `page_data`

On a full reload, chatgpt.com doesn't fetch the open chat: it puts it in the page's HTML, and inline scripts pass it to the page with `window.__reactRouterContext.streamController.enqueue("…")`. The extension replaces that controller with one that sends each chunk here first, in order (`src/pagedata.ts`).

```json
{ "site": "chatgpt.com", "conversation": "<the chat's id, from the address>", "text": "<the chunk>" }
```

The reply is the chunk with placeholders restored: `{"text": "…", "restored": 1}`.

### `observe`

Sent only while "Capture traffic" is on in the Veil app (`status` says `capture: true`). It's a debugging setting, for seeing how a site loads and streams chats when it changes. The extension then reports what the chat page does: every `fetch` and XHR, WebSocket and EventSource traffic, address changes, and the data built into the page, with request and reply bodies up to 256 KB each.

```json
{ "site": "chatgpt.com", "kind": "fetch", "method": "POST", "path": "/backend-api/…", "status": 200, "detail": { … } }
```

The app writes each report to its capture folder on the computer. These reports hold page content as it was, real values included; they never leave the computer. Nothing is reported while capture is off. The reply is `{"written": true}` or `{"written": false}`.

### `ping`

The host also answers `ping` with `{"host": "<the app's version>"}`, without asking the app. The extension doesn't send it today.
