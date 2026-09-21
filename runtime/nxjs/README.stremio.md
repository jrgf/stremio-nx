# Vendored nx.js runtime

This directory contains the patched native and TypeScript runtime required by
Stremio NX. It is based on [nx.js](https://github.com/TooTallNate/nx.js), whose
MIT license is retained in `LICENSE`. The source snapshot includes local media,
V8 allocation, rendering and platform changes; it is not an unmodified upstream
release. The sibling checkout used while developing it had HEAD
`0cf554a3d5946117ef1224594d89bfe0a7addf02`.

The `inspect` and `ws` packages are copied here as source. The standalone root
manifest and lockfile replace development symlinks into that sibling checkout.
The kleur fork is pinned to the same commit used by the previous local build.
Geist Mono is vendored under `assets/` with its SIL OFL notice.

From the project root:

```sh
npm ci
npm ci --prefix runtime/nxjs
npm run build:nro
```

`scripts/build-runtime.sh` compiles the inspection helper and runtime bundle on
the host, then cross-compiles native code in the pinned devkitPro Docker image.
Generated code, build products and dependency directories are ignored by Git.
The Docker image supplies native libraries; see the root `LICENSE_REVIEW.md`
for the corresponding-source and notice work still required for public releases.
