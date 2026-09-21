# License review — September 20, 2026

The inspected dependencies are free/open-source. **The current NRO is not
cleared for public distribution yet.** This is a technical license inventory,
not a jurisdiction-specific legal opinion or a complete source-file audit.

## What this application uses

| Component | Evidence / license |
|---|---|
| Stremio core-web 0.62.1, JS/WASM | [Exact release license](https://github.com/Stremio/stremio-core/blob/stremio-core-web-v0.62.1/LICENSE.md): MIT; preserve SmartCode OOD notice |
| nx.js and bundled JavaScript helpers | MIT; runtime source-map inventory includes actual installed versions |
| Stremio Rust dependencies | 178 registry packages, one MIT Git dependency and four MIT workspace packages; metadata shows free/open-source licenses |
| FFmpeg 7.1-5 | Actual toolchain archive contains `--enable-gpl --enable-static --enable-nvtegra` and “GPL version 2 or later”; no `--enable-nonfree` |
| V8, Skia, dav1d, WebP | BSD-family main licenses; embedded third-party code needs separate notices |
| Mesa, libdrm, libuv, libnx, HarfBuzz | Permissive licenses; HarfBuzz's actual COPYING says Old MIT despite package metadata saying LGPL |
| Mbed TLS / bundled Abseil | Apache-2.0; requires notice preservation and compatibility review |
| FreeType, JPEG, PNG, zlib, bzip2, Zstandard | Free licenses with attribution/alternative-license conditions |
| Geist Mono font | SIL Open Font License; collected from installed package |

Source imports and bundle maps show Stremio core-web, not a bundled copy of
Stremio's proprietary streaming server or its separate web UI. The torrent,
HTTP and control-server implementations are local. This does not prove the
provenance of every locally authored line.

## Public-release requirements

1. Original project code now uses **GPL-3.0-or-later** (`LICENSE`, `COPYRIGHT`
   and package metadata). GPLv3 is the distribution route for this linked
   build: FFmpeg permits later GPL versions, and
   [Apache-2.0 is compatible with GPLv3, not GPLv2-only](https://www.apache.org/licenses/GPL-compatibility).
   Upstream files retain their own notices/licenses.
2. Supply complete corresponding source, modifications and build scripts for
   the released GPL executable, including exact native dependencies/patches.
   A Docker image, NRO, or upstream homepage alone is insufficient. Follow
   [FFmpeg's guidance](https://ffmpeg.org/legal.html) and the
   [GPL distribution requirements](https://www.gnu.org/licenses/gpl-3.0.html#section6).
3. Finish nested V8/Skia/native and WASM dependency notices and source provenance.
   `THIRD_PARTY_NOTICES.txt` contains collected notices, not a complete clearance.
   Registry metadata and a release Cargo.lock do not prove which source files
   produced the published WASM artifact. Retain compiler runtime exceptions.
4. Keep independent branding. Code licenses do not establish trademark rights.
   The new icon is original generated artwork, not Stremio/Nintendo artwork.
   Online services, add-ons, metadata and video rights are separate; see
   [Stremio's terms](https://www.stremio.com/tos). Codec patents and platform
   restrictions may depend on jurisdiction and distribution model.

Evidence, exact package inventories, FFmpeg configuration and retrieved notices
are in `results/license-review/`. No proprietary dependency was identified in
the inspected inventory; the unresolved release requirements prevent a blanket
“everything is legally cleared” conclusion.
