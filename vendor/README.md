# Vendored packages

The extension is built from these two packages, kept here so that anyone can
build it from this repository alone and get the same files as the release.

| File | What | Built from | SHA-256 |
| --- | --- | --- | --- |
| `veil-engine-0.2.1.tgz` | The redaction engine and the sites' handling, as WebAssembly (`veil-engine-wasm`) | [veil-engine](https://github.com/Oram-Labs/veil-engine) at `8387207` (branch `site/gemini`), with `scripts/build-npm.sh` | `8b278e2a19266256708952aab25c513b4000c0602fb06ad38dff491e78bb0329` |
| `veil-ui-0.1.3.tgz` | The settings screens shared with the Veil app | [veil-ui](https://github.com/Oram-Labs/veil-ui) at `25831b8`, with `pnpm build && npm pack` | `f2e66508e3e798c815964280b267cac2676d86af0e6578f0e16f7ea470c9d8d8` |

The engine package was built with Rust 1.99.0 and wasm-bindgen 0.2.130,
without wasm-opt (binaryen wasn't installed), so it's about 10% larger
than a release build; rebuild it with wasm-opt before a release. A WebAssembly build depends on those versions, so
rebuilding it elsewhere may not give the same bytes; the package here is the
one the release used.
