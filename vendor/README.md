# Vendored packages

The extension is built from these two packages, kept here so that anyone can
build it from this repository alone and get the same files as the release.

| File | What | Built from | SHA-256 |
| --- | --- | --- | --- |
| `veil-engine-0.2.1.tgz` | The redaction engine and the sites' handling, as WebAssembly (`veil-engine-wasm`) | [veil-engine](https://github.com/Oram-Labs/veil-engine) at `83cd113`, with `scripts/build-npm.sh` | `0c614f5c09ea4d379437d68cfa1d39e09556eab74a31da07de9655ce6a31c8cf` |
| `veil-ui-0.1.3.tgz` | The settings screens shared with the Veil app | [veil-ui](https://github.com/Oram-Labs/veil-ui) at `25831b8`, with `pnpm build && npm pack` | `f2e66508e3e798c815964280b267cac2676d86af0e6578f0e16f7ea470c9d8d8` |

The engine package was built with Rust 1.99.0, wasm-bindgen 0.2.130 and
wasm-opt 112 (binaryen). A WebAssembly build depends on those versions, so
rebuilding it elsewhere may not give the same bytes; the package here is the
one the release used.
