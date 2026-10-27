# Threat model: veil-chrome

Oct 2026. The extension's own risks. The redaction it relies on is covered by [veil-engine's threat model](https://github.com/Oram-Labs/veil-engine/blob/main/THREAT_MODEL.md); the Veil app is not open source.

## What it protects against

**Sending detected values to claude.ai or chatgpt.com by accident**, when you type into those sites in the browser. The extension makes sure what the page sends goes through the Veil app first, which replaces the values it detects with placeholders, and that replies come back through the app to be restored. Like the engine, it's a safety net for mistakes, not a guarantee that nothing sensitive is sent.

## Who and what is trusted

| Party | Trusted? | Why |
|---|---|---|
| You, your computer and your browser profile | Yes | An attacker who controls them can read what you type before the extension sees it. |
| The Veil app | Yes | It receives every chat request and reply on the two sites, in plain form ([PROTOCOL.md](PROTOCOL.md)). |
| claude.ai and chatgpt.com | No | This is who the values are kept from. |
| Other websites and other extensions | No | The extension accepts no messages from them (`externally_connectable` is not set). |

## What the extension sees, and where it goes

- **It sees** every request and reply on claude.ai and chatgpt.com that can carry chat text (`src/sites.ts`), and the chat data built into chatgpt.com pages on a reload.
- **It sends them only to the Veil app**, through the native messaging host `com.veil.app.native`. It has no server addresses in its code and opens no connections of its own (`tests/guarantees.test.ts`).
- **It stores** only the number of values replaced in each tab (until the tab closes) and your preferences. No text.
- **With "Capture traffic" on in the app**, a debugging setting, the extension also reports what the chat page does, with request and reply bodies, to the app, which writes them to its capture folder on your computer. These hold real values and stay on the computer. Nothing is reported while it's off.

## Risks, and what limits them

### The app isn't running

Requests that send text are blocked, and the page says why. Loading chats still works, showing placeholders. **Limit:** you can choose "send without protection" for a site in the popup, which then lets messages through unredacted while the app is unreachable. The popup shows when that is on.

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
