# Vendored packages

The extension is built from these two packages, kept here so that anyone can
build it from this repository alone and get the same files as the release.

| File | What | Built from | SHA-256 |
| --- | --- | --- | --- |
| `veil-engine-0.2.1.tgz` | The redaction engine and the sites' handling, as WebAssembly (`veil-engine-wasm`) | [veil-engine](https://github.com/Oram-Labs/veil-engine) at `3d6cb69` (branch `site/gemini`), with `scripts/build-npm.sh` | `63f6b5c1dca729adaa48ca3e0551e93076433277eb7d5af150f593d938df4777` |
| `veil-ui-0.1.5.tgz` | The settings screens shared with the Veil app | [veil-ui](https://github.com/Oram-Labs/veil-ui) at `a954348` (branch `site/gemini`), with `pnpm build && npm pack` | `3e99a808b1ecdbf8f9fabe2946b3d54b53099a77fb1372b19939d7addcc361ac` |

The engine package was built with Rust 1.99.0 and wasm-bindgen 0.2.130,
without wasm-opt (binaryen wasn't installed), so it's about 10% larger
than a release build; rebuild it with wasm-opt before a release. A WebAssembly build depends on those versions, so
rebuilding it elsewhere may not give the same bytes; the package here is the
one the release used.
