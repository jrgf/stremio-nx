#!/bin/bash
# Compiles and runs the media-source host test against the fork's source.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
NXJS="${NXJS_DIR:-$HERE/runtime/nxjs}"
OUT="$HERE/host-test/dist"
mkdir -p "$OUT"
clang++ -std=c++20 -Wall -Wextra -O1 -pthread -I "$NXJS/source" \
	"$NXJS/source/media-source.cc" "$HERE/host-test/media-source/test.cc" \
	-o "$OUT/media-source-test"
"$OUT/media-source-test"
