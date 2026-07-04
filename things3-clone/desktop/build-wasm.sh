#!/usr/bin/env bash
# Compile the Go CRDT engine (core/crdt) to WASM for the browser and stage it in
# the app's public/ folder (served at the web root by Expo, and copied into the
# web export / desktop bundle). Run this before `expo export` / the desktop
# build whenever core/crdt or core/wasm changes.
set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="../public"
mkdir -p "$OUT_DIR"

echo "▸ Building crdt.wasm (GOOS=js GOARCH=wasm)"
GOOS=js GOARCH=wasm go build -o "$OUT_DIR/crdt.wasm" ./core/wasm

# The JS glue that boots the module must match the compiling toolchain.
echo "▸ Copying wasm_exec.js from $(go env GOROOT)"
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$OUT_DIR/wasm_exec.js"

echo "✓ Staged: $OUT_DIR/{crdt.wasm, wasm_exec.js} (worker: $OUT_DIR/crdt.worker.js)"
