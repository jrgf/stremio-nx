#!/bin/bash
# Packages romfs/ into a fat NRO using the patched runtime from runtime/nxjs.nro
# (built by scripts/build-runtime.sh). The stock runtime lacks the app's media
# extensions and must never be used as a fallback.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
STOCK="$HERE/node_modules/@nx.js/nro/dist/nxjs.nro"
PATCHED="$HERE/runtime/nxjs.nro"

if [ -f "$PATCHED" ]; then
	cp "$PATCHED" "$STOCK"
	echo "==> packaging with patched runtime ($(du -h "$PATCHED" | cut -f1))"
else
	echo "ERROR: runtime/nxjs.nro is missing; run scripts/build-runtime.sh first." >&2
	exit 1
fi

cd "$HERE"
cp THIRD_PARTY_NOTICES.txt romfs/THIRD_PARTY_NOTICES.txt
cp LICENSE COPYRIGHT romfs/
npx nxjs-nro --fat
