#!/bin/bash
# Builds the patched nx.js runtime from the workspace copy and copies the
# result to runtime/nxjs.nro. JS steps run on the host; the aarch64
# cross-compile runs in the nx.js CI toolchain image (no Node inside it).
#
#   scripts/build-runtime.sh            # incremental
#   scripts/build-runtime.sh clean      # full rebuild
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
NXJS="${NXJS_DIR:-$HERE/runtime/nxjs}"
IMAGE="ghcr.io/tootallnate/pacman-packages@sha256:92880d77878639768fe3696800104d68de1dfec65802bf7915689dd7bd718e53"

cd "$NXJS"
echo "==> nx.js at $NXJS"

if [ "${1-}" = "clean" ]; then
	docker run --rm --platform linux/amd64 -v "$NXJS:/work" -w /work -e DEVKITPRO=/opt/devkitpro "$IMAGE" make clean
fi

echo "==> host: build runtime types + bundle runtime.js"
node node_modules/typescript/bin/tsc -p packages/inspect
cd packages/runtime
node build.mjs
node bundle.mjs
node check-def-names.mjs
cd "$NXJS"
node tools/embed-runtime.mjs packages/runtime/runtime.js source/runtime_js.c

echo "==> container: make nxjs.nro"
docker run --rm --platform linux/amd64 -v "$NXJS:/work" -w /work -e DEVKITPRO=/opt/devkitpro "$IMAGE" \
	make -j4 GEIST_MONO_TTF=assets/GeistMono-Regular.ttf

mkdir -p "$HERE/runtime"
cp "$NXJS/nxjs.nro" "$HERE/runtime/nxjs.nro"
ls -la "$HERE/runtime/nxjs.nro"
echo "==> done"
