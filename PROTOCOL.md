# Protocol: what the extension sends to the Veil app

The extension talks to one program only: the native messaging host `com.veil.app.native`, which the Veil app installs. Chrome starts the host and connects the extension to it over the host's standard input and output. The extension's only network request of its own is the popup's GET of `https://getveil.tech/download/latest.json`, at most every 6 hours, to say when a newer version is out (`src/popup/update.ts`); it sends nothing about the user.

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
  "fail_closed": true, "sites": { "claude.ai": true, "chatgpt.com": true }, "capture": false,
  "documents": { "enabled": true, "max_mb": 25,
    "formats": [
      { "id": "pdf", "name": "PDF", "extensions": ["pdf"], "mime_types": ["application/pdf"], "guard": true },
      { "id": "text", "name": "Text", "extensions": ["txt", "md", "csv", "json", "env", "py", "…"], "mime_types": ["text/plain", "…"], "guard": false } ] } }
```

`updates_until` is the last day of the license key's updates (`YYYY-MM-DD`), present while the key is accepted: the key covers app versions released up to then, so the popup offers a newer version's download only if the key covers it, and renewing otherwise. `sites` says which sites Veil protects. `capture` is the app's "Capture traffic" setting (see `observe`). `documents` says which attached files to send to Veil (see `document`): by extension (a name that starts with a dot also counts its first part, so `.env.local` is an `env` file) or by media type. `guard` says whether the safety net below applies to that type; absent means true. Until Veil answers, the extension uses a built-in list of PDF and the common text types.

### `request`

A request the page is about to send. Sent only for requests that match `src/sites.ts`: the ones that can carry chat text, or bring it back. Everything else on the page goes to the site without the extension touching it.

```json
{ "site": "chatgpt.com", "method": "POST", "path": "/backend-api/f/conversation", "body": "<base64>" }
```

`body` is absent for `GET`. A request that sends text also says which documents were attached before it, when there were any: `draft`, the page's draft id (see `document`), and `veil_files`, how many of the files uploaded since the last send were Veil's redacted text, so Veil doesn't count them as files it couldn't check. The reply is a decision:

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

### `document`

A file the user is attaching on the site, of a type `status` lists in `documents`: picked in a file chooser, dropped or pasted (`src/catch.ts`). The extension stops the file before the page gets it and sends it here; other files go to the page untouched.

```json
{ "site": "claude.ai", "page": "/chat/<id>", "draft": "<random id>", "name": "contract.pdf", "size": 48213, "data": "<base64>" }
```

`page` is the page's path, which names the chat once it has started. A new chat has no id yet, so the page keeps a random `draft` id: documents are redacted under it, and the chat's first send carries it (see `request`), so the chat uses the same placeholders. `data` is absent when the file is larger than `documents.max_mb`. The reply is a decision:

```json
{ "action": "replace", "name": "contract (redacted).md", "mime": "text/markdown", "text": "…", "redacted": 5, "pages": 2 }
```

A PDF comes back as Markdown; a text file keeps its extension (`data (redacted).csv`, or `.txt` for a name without one, such as `.env`), decoded to UTF-8 from whatever encoding it was in.

```json
{ "action": "replace", "name": "data (redacted).csv", "mime": "text/csv", "text": "…", "redacted": 2, "pages": 1 }
```

| `action` | What the extension does |
|---|---|
| `replace` | Gives the page a text file called `name`, holding `text`: the document's text with sensitive values replaced by placeholders |
| `pass` | Gives the page the file as it is, for a file Veil can't read whose settings let it through; shows `message` |
| `block` | Gives the page nothing; shows `message` |

**If Veil can't be reached**, the file isn't attached, and the page says why, unless the user has turned on "send without protection" for that site. As a safety net, an upload whose body holds a document of a guarded type (PDF) that Veil hasn't seen is refused (`src/documents.ts`). Text isn't guarded: pages make text and JSON files of their own, so only the text files the user attaches go to Veil.

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

### `open`

Sent only by the popup's **Open Veil** button, when the app is installed but not running. The host, which is the app's own program started by Chrome, opens the app (on macOS through Launch Services) and answers `{"started": true}`, or `{"started": false}` if Veil was already running. The extension doesn't accept it from pages. Apps before 0.1.28 answer `unknown_op`, and the popup then says to open Veil from Applications or the Start menu.

### `ping`

The host also answers `ping` with `{"host": "<the app's version>"}`, without asking the app. The extension doesn't send it today.
