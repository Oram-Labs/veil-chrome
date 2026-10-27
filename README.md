# veil-chrome

The browser extension of [Veil](https://getveil.tech). It keeps personal data and secrets out of what you type into **claude.ai** and **chatgpt.com**: before your message leaves the browser, Veil replaces values such as email addresses and phone numbers with placeholders like `[EMAIL_1]`, and shows the real values again in the reply, in reopened chats and in the sidebar. PDFs and text files you attach are attached as their text, with the same values replaced.

It runs in Chrome, Edge, Brave and other Chromium browsers, and needs the Veil app on the same computer.

```text
you type           Write to ana@example.com
the site gets      Write to [EMAIL_1]
the reply shows    I wrote to ana@example.com.
```

## What it does, and what the app does

The extension doesn't redact anything itself. It catches what the page is about to send, and the chat data the page receives, and hands it to the **Veil app** through Chrome's native messaging. The app does the redacting and restoring, and keeps the placeholders on your computer.

```text
claude.ai or chatgpt.com page  ──►  veil-chrome  ──native messaging──►  Veil app on your computer
                               ◄──  (rewritten request, restored reply)  ◄──
```

The redaction itself is done by the open-source [veil-engine](https://github.com/Oram-Labs/veil-engine). The Veil app around it, including the parts that know which fields of each site's requests are chat text, is not open source. [PROTOCOL.md](PROTOCOL.md) lists exactly what the extension sends to the app.

## Promises

Each of these is checked by a test (`tests/guarantees.test.ts`, `e2e/mock.spec.ts`):

- **It talks only to the Veil app.** No server addresses in its code, no connections of its own; it reaches the app through the native messaging host `com.veil.app.native` and nothing else.
- **It only wraps the page's own requests.** `fetch` goes through Veil first. `XMLHttpRequest`, `WebSocket` and `EventSource` are wrapped only to report traffic while "Capture traffic" is on in the app. On chatgpt.com it also passes the chat data built into a reloaded page through Veil.
- **It only touches the requests that can carry chat text** (`src/sites.ts`). Everything else goes to the site untouched, without reaching the app.
- **It fails closed.** If the app can't be reached, messages are blocked and the page says why, unless you chose "send without protection" for that site in the popup.
- **It only catches the files Veil reads.** Files you attach of a type Veil reads (PDF and text files) go to the Veil app first; any other file goes to the site untouched.
- **It stores no text:** only how many values were replaced in each tab, and your preferences.
- **Its permissions are only** native messaging and storage, on claude.ai and chatgpt.com.
- **It isn't minified,** so you can read the code inside the zip you install.

[THREAT_MODEL.md](THREAT_MODEL.md) says what it protects against and what it doesn't.

## Install

From the [Chrome Web Store](https://chromewebstore.google.com/detail/veil/lanejpecogmomcibpjcomddmkgpagneb), with the [Veil app](https://getveil.tech) installed and running. In Edge, allow extensions from other stores when it asks.

To try your own build: `pnpm build`, then in `chrome://extensions` turn on Developer mode, choose **Load unpacked** and pick `dist/unpacked`. The Veil app accepts both the Store's copy and unpacked builds.

## Check the extension you have

The build is reproducible: the same source always gives the same files.

```sh
git clone https://github.com/Oram-Labs/veil-chrome && cd veil-chrome
git checkout v0.2.0                   # the version shown in chrome://extensions
pnpm install --frozen-lockfile
pnpm verify <the extension's folder>
```

Chrome keeps the extension it installed from the Store in your profile, under `Extensions/lanejpecogmomcibpjcomddmkgpagneb/<version>_0`. On macOS that is `~/Library/Application Support/Google/Chrome/Default/Extensions/…`; on Windows, `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\…`; on Linux, `~/.config/google-chrome/Default/Extensions/…`.

`pnpm verify` builds the extension again and compares every file. The Store's copy differs only in two fields the Store sets in `manifest.json`, `key` and `update_url`, and a `_metadata` folder it adds; `verify` reports those and allows them. It also takes a release zip from GitHub: each release has two, `veil-extension-<version>.zip` and the `-store.zip` uploaded to the Chrome Web Store (the same files without `key`), each with its SHA-256 and a build attestation linking it to the release's commit.

## Develop

Needs Node 22 and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm check        # types
pnpm test         # unit tests and the guarantee tests
pnpm build        # dist/unpacked
pnpm zip          # dist/veil-extension-<version>.zip, and -store.zip without "key" for the Store
pnpm test:e2e     # Chromium with the extension, against local stand-ins
```

The end-to-end tests run the extension in Chromium against local stand-ins for claude.ai and chatgpt.com, with `e2e/mock-host.mjs` standing in for the Veil app. Run `pnpm build` and `npx playwright install chromium` first.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
