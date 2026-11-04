# Threat model: veil-chrome

Nov 2026. The extension's own risks, with the Veil app and with its built-in engine. The redaction it relies on is covered by [veil-engine's threat model](https://github.com/Oram-Labs/veil-engine/blob/main/THREAT_MODEL.md); the Veil app is not open source.

## What it protects against

**Sending detected values to claude.ai or chatgpt.com by accident**, when you type into those sites in the browser. The extension makes sure what the page sends goes through the Veil app first (or, without the app, through its built-in engine), which replaces the values it detects with placeholders, and that replies come back through the same engine to be restored. Like the engine, it's a safety net for mistakes, not a guarantee that nothing sensitive is sent.

## Who and what is trusted

| Party | Trusted? | Why |
|---|---|---|
| You, your computer and your browser profile | Yes | An attacker who controls them can read what you type before the extension sees it. |
| The Veil app | Yes | It receives every chat request and reply on the two sites, in plain form ([PROTOCOL.md](PROTOCOL.md)). |
| The built-in engine | Yes | It is part of the extension: code you can read in this repository and in [veil-engine](https://github.com/Oram-Labs/veil-engine), run as WebAssembly in the extension's service worker. It makes no network requests. |
| claude.ai and chatgpt.com | No | This is who the values are kept from. |
| Other websites and other extensions | No | The extension accepts no messages from them (`externally_connectable` is not set). |

## What the extension sees, and where it goes

- **It sees** every request and reply on claude.ai and chatgpt.com that can carry chat text (`src/sites.ts`), and the chat data built into chatgpt.com pages on a reload.
- **It sends them only to the Veil app**, through the native messaging host `com.veil.app.native`. Its one connection of its own is the popup's GET of `https://getveil.tech/download/latest.json`, without cookies and with nothing about you in it, to say when a newer version is out; it's the only server address in its code (`tests/guarantees.test.ts`).
- **It stores** your preferences and, for the built-in engine, its settings, rules and activity counts (kinds and counts, no values). **In memory, until the browser closes** (Chrome's session storage, not written to disk): the number of values replaced in each tab, which engine each chat used (by the chat's id, the most recent 500), and the values behind the built-in engine's placeholders (below). No chat text.
- **With "Capture traffic" on in the app**, a debugging setting, the extension also reports what the chat page does, with request and reply bodies, to the app, which writes them to its capture folder on your computer. These hold real values and stay on the computer. Nothing is reported while it's off.

## Risks, and what limits them

### The app isn't running

Requests that send text are blocked, and the page says why. Loading chats still works, showing placeholders. **Limit:** you can choose "send without protection" for a site in the popup, which then lets messages through unredacted while the app is unreachable. The popup shows when that is on.

### The built-in engine's placeholders

Without the app, the extension has to remember which value each placeholder stands for ("ana@example.com is `[EMAIL_1]` in this chat") to restore replies. It keeps that only in Chrome's session storage: in memory, never written to disk, readable only by the extension's own pages and service worker (not by the sites' pages or content scripts), and emptied when the browser closes. **Forget values now** and **Delete everything**, in the extension's settings, empty it sooner.

**Protects against:** anyone who reads the browser profile's files, now or later (a backup, a copied disk, a script that reads the extension's storage files): the real values are never there.

**Doesn't protect against:** anything that can read the browser's memory or run as this extension while the browser is open. The values are not encrypted in memory.

**Limits:** after the browser restarts, earlier chats show their placeholders, and a new message in such a chat starts numbering again, so `[EMAIL_1]` may stand for a different address than in the chat's earlier messages; the model sees both. The Veil app keeps values for good, encrypted, on the computer. Chrome's session storage holds about 10 MB; when it is full, the oldest values are forgotten first.

### Attached files without the app

The built-in engine doesn't read files. Without the app, a file you attach is sent as it is, with a notice on the page, or held back if you chose **Block** for files Veil can't check in the extension's settings. **Limit:** with the default (**Warn**), what is in the file reaches the site unredacted; choose **Block** if that matters, or use the app.

### Two engines, one chat

A placeholder means a value only to the engine that made it. If a chat were started with one engine and continued with the other, `[EMAIL_1]` could stand for a different address, and a reply would be restored to the wrong value. So a chat stays with the engine that started it, and when that engine isn't available the message is blocked rather than sent through the other. **Limit:** the chat is recognised by its address; a new chat is attributed to its tab for ten minutes until its address names it. After the browser restarts, or for a chat whose record was dropped (the record keeps the last 500), the chat goes to the app first; the built-in engine had nothing left of it anyway.

### The site changes

The extension knows which requests carry chat text by their paths, and how chatgpt.com builds chat data into its pages. If a site changes these, text can go through a path the extension doesn't catch. **Limits:** the app's own checks (it blocks requests it can't read, as set in its Behavior settings), the "Capture traffic" setting for seeing what changed, and updates to `src/sites.ts`.

### The page's own scripts

The extension's hook runs in the page, alongside the site's scripts, so the site could get around it, for example by keeping its own copy of `fetch` from before the hook ran. **Limit:** the hook runs at `document_start`, before the site's scripts. And the site is where the text was going anyway: getting around the hook gives it nothing it couldn't have had.

### Another program pretending to be the extension or the host

- **Pretending to be the extension:** the app's host manifest lets only two IDs start the host: the Chrome Web Store's copy, and unpacked builds, whose ID comes from the public key in `static/manifest.json`. That key is public, so anyone can load an unpacked copy with the same ID in developer mode. Doing that on your computer needs control of your browser, which is out of scope.
- **Pretending to be the host:** a program that replaced the host's manifest in Chrome's `NativeMessagingHosts` folder would receive the chat text. Doing that needs write access to your user folder, which is out of scope.

### Chat data restored into the page

On a chatgpt.com reload, values are restored inside chat data that the page then parses. A value that would need escaping there is left as a placeholder rather than restored in a way that could break the page.

## Out of scope

- An attacker with access to your account, computer or browser profile.
- Other extensions with permission to read claude.ai or chatgpt.com: they can read the page, as they could without Veil.
- What the sites do with the redacted text.
- The Veil app's own handling of what it receives, beyond [PROTOCOL.md](PROTOCOL.md).

## Reporting a vulnerability

Please report it privately; see [SECURITY.md](SECURITY.md). Don't open a public issue.
