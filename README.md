# veil-chrome

The browser extension of [Veil](https://getveil.tech). It keeps personal data and secrets out of what you type into **claude.ai** and **chatgpt.com**: before your message leaves the browser, Veil replaces values such as email addresses and phone numbers with placeholders like `[EMAIL_1]`, and shows the real values again in the reply, in reopened chats and in the sidebar. PDFs and text files you attach are attached as their text, with the same values replaced.

It runs in Chrome, Edge, Brave and other Chromium browsers. With the [Veil app](https://getveil.tech) on the same computer, the app does the work. Without it, the extension has a built-in engine of its own, which needs a Veil license key.

```text
you type           Write to ana@example.com
the site gets      Write to [EMAIL_1]
the reply shows    I wrote to ana@example.com.
```

## Two engines

The extension catches what the page is about to send, and the chat data the page receives, and has it redacted and restored by one of two engines. It asks the **Veil app** first, through Chrome's native messaging. Only if the app can't be reached (not installed, not running) does the **built-in engine** answer, and only if you have saved a license key in the extension's settings.

```text
claude.ai or chatgpt.com page  ──►  veil-chrome ──native messaging──►  Veil app on your computer
                               ◄──   (rewritten request, restored reply)   ◄──
                                         └─ no app? ──►  built-in engine, in this extension
```

- **The Veil app** keeps the placeholders on your computer, reads PDFs and can detect names. [PROTOCOL.md](PROTOCOL.md) lists exactly what the extension sends to it.
- **The built-in engine** is the open-source [veil-engine](https://github.com/Oram-Labs/veil-engine) and the code that knows which fields of each site's requests are chat text, compiled to WebAssembly and run inside the extension. It reads text files, not PDFs, and doesn't detect names. The values behind placeholders are kept encrypted in the browser; [THREAT_MODEL.md](THREAT_MODEL.md) says how, and what that does and doesn't protect against. Its settings are the app's own screens (the [veil-ui](https://github.com/Oram-Labs/veil-ui) package), in the extension's settings page.

A chat stays with the engine that started it, because only that engine knows what its placeholders stand for. If that engine isn't there later, the message waits instead of going to the other one.

## Promises

Each of these is checked by a test (`tests/guarantees.test.ts`, `e2e/mock.spec.ts`, `e2e/local.spec.ts`):

- **What you type goes only to the Veil app, or to the built-in engine inside the extension.** It reaches the app through the native messaging host `com.veil.app.native`; the built-in engine makes no network requests at all. The extension's one connection of its own is the popup reading `https://getveil.tech/download/latest.json`, at most every 6 hours, to say when a newer Veil or extension is out: a plain GET, without cookies, that carries nothing about you (`src/popup/update.ts`).
- **It only wraps the page's own requests.** `fetch` goes through Veil first. `XMLHttpRequest`, `WebSocket` and `EventSource` are wrapped only to report traffic while "Capture traffic" is on in the app. On chatgpt.com it also passes the chat data built into a reloaded page through Veil.
- **It only touches the requests that can carry chat text** (`src/sites.ts`). Everything else goes to the site untouched, without reaching the app.
- **It fails closed.** If neither the app nor the built-in engine can be used, messages are blocked and the page says why, unless you chose "send without protection" for that site in the popup.
- **It only catches the files Veil reads.** Files you attach of a type Veil reads (PDF and text files) go to the Veil app first; any other file goes to the site untouched.
- **It stores no chat text in the clear:** only how many values were replaced in each tab, your preferences, which engine each chat used and, for the built-in engine, its settings, rules, license key, activity counts and the values behind its placeholders, encrypted.
- **Its permissions are only** native messaging and storage, on claude.ai and chatgpt.com. Its one content security policy allows the engine's WebAssembly (`'wasm-unsafe-eval'`) and nothing else beyond the default.
- **It isn't minified,** so you can read the code inside the zip you install.

[THREAT_MODEL.md](THREAT_MODEL.md) says what it protects against and what it doesn't.

## Install

From the [Chrome Web Store](https://chromewebstore.google.com/detail/veil/lanejpecogmomcibpjcomddmkgpagneb), with the [Veil app](https://getveil.tech) installed and running. In Edge, allow extensions from other stores when it asks.

The built-in engine needs a license key, entered in the extension's settings (the toolbar icon, then **Settings**). The Veil app shares its key with the extension when it is running, so the extension can use it later without the app.

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

`pnpm verify` builds the extension again and compares every file. The built-in engine is the installed `veil-engine` package (WebAssembly), pinned by `pnpm-lock.yaml`; building it from its source is checked in that repository. The Store's copy differs only in two fields the Store sets in `manifest.json`, `key` and `update_url`, and a `_metadata` folder it adds; `verify` reports those and allows them. It also takes a release zip from GitHub: each release has two, `veil-extension-<version>.zip` and the `-store.zip` uploaded to the Chrome Web Store (the same files without `key`), each with its SHA-256 and a build attestation linking it to the release's commit.

## Develop

Needs Node 22 and pnpm, and the `veil-engine` and `veil-ui` packages the lockfile names.

```sh
pnpm install --frozen-lockfile
pnpm check        # types
pnpm test         # unit tests and the guarantee tests
pnpm build        # dist/unpacked
pnpm zip          # dist/veil-extension-<version>.zip, and -store.zip without "key" for the Store
pnpm test:e2e     # Chromium with the extension, against local stand-ins
```

The end-to-end tests run the extension in Chromium against local stand-ins for claude.ai and chatgpt.com, with `e2e/mock-host.mjs` standing in for the Veil app (`e2e/mock.spec.ts`), and with no app at all for the built-in engine (`e2e/local.spec.ts`, which builds the extension with an engine package that accepts the test license: `VEIL_ENGINE_DIR`, `VEIL_TEST_LICENSE`). Run `pnpm build` and `npx playwright install chromium` first.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
