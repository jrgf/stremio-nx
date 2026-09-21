#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$ROOT/host-test/dist"
"${CXX:-clang++}" -std=c++20 -O1 -g -Wall -Wextra -pthread -fsanitize="${SANITIZERS:-undefined}" \
  -I "$ROOT/host-test/mman" -I "$ROOT/runtime/nxjs/source" \
  "$ROOT/host-test/mman/test.cc" -o "$ROOT/host-test/dist/mman-test"
"$ROOT/host-test/dist/mman-test"
