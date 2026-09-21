#!/bin/bash
# Compiles the fork's HTTP range reader natively and tests it against the Node
# range server. Usage: host-test/http-reader/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
NXJS="${NXJS_DIR:-$HERE/runtime/nxjs}"
OUT="$HERE/host-test/dist"
PORT=18471
mkdir -p "$OUT"

npx esbuild --bundle --platform=node --target=node22 --format=esm \
	--outfile="$OUT/range-server.mjs" "$HERE/host-test/range-server.ts" --log-level=warning
clang++ -std=c++20 -Wall -Wextra -O1 -I "$NXJS/source" \
	"$NXJS/source/http-reader.cc" "$HERE/host-test/http-reader/test.cc" -o "$OUT/http-reader-test"

# 3 MiB of pseudo-random data, not a multiple of the server's chunk size.
node -e "const b=Buffer.alloc(3*1048576+777);let x=1;for(let i=0;i<b.length;i++){x=(x*1103515245+12345)>>>0;b[i]=x>>>24;}require('fs').writeFileSync('$OUT/range.bin',b)"

node "$OUT/range-server.mjs" "$OUT/range.bin" $PORT &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
"$OUT/http-reader-test" "http://127.0.0.1:$PORT/file" "$OUT/range.bin"
