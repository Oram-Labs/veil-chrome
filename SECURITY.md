# Security policy

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub: on this repository's **Security** tab, choose **Report a vulnerability**, or go to <https://github.com/Oram-Labs/veil-chrome/security/advisories/new>.

Useful to include:

- what an attacker can do, and what they need first;
- the smallest page, request or steps that show it;
- the extension version (in `manifest.json`) and browser you tested.

We aim to reply within a week, and will tell you when a fix is released. If you'd like credit in the advisory, say how you'd like to be named.

## What counts

Anything that breaks a promise in the [README](README.md#promises) or the [threat model](THREAT_MODEL.md). For example:

- chat text on claude.ai or chatgpt.com reaching the site without going through Veil, while Veil is running and protecting that site;
- the extension sending anything anywhere other than the Veil app's native messaging host;
- a web page or another extension getting the extension to act for it;
- sends going through while Veil can't be reached and "send without protection" is off;
- text kept in the extension's storage.

A value that Veil doesn't recognise, or a new kind of request a site starts using, is a detection or compatibility gap rather than a vulnerability. Please open an ordinary issue for it, with a made-up example.

Problems in the redaction itself belong to [veil-engine](https://github.com/Oram-Labs/veil-engine/security).

## Supported versions

Fixes go into the latest release.
