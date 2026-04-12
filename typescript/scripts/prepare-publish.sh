#!/usr/bin/env bash
set -euo pipefail

# prepare-publish.sh — copy repo-root files into typescript/ for npm pack.
#
# After the 2026-03-22 protobuf-style monorepo refactor (ef2510f), README,
# LICENSE, SECURITY, and conformance vectors live outside typescript/ but
# package.json "files" still lists them as tarball contents. This script
# copies from their canonical locations so `npm pack` finds them.
#
# Destinations are gitignored in typescript/.gitignore.
# Runs as the first step of prepublishOnly (see package.json).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$PKG_DIR")"

echo "prepare-publish: copying files into typescript/ for npm pack..."

for f in README.md LICENSE SECURITY.md; do
  if [[ ! -f "$REPO_ROOT/$f" ]]; then
    echo "ERROR: $REPO_ROOT/$f not found — cannot prepare tarball" >&2
    exit 1
  fi
  cp "$REPO_ROOT/$f" "$PKG_DIR/$f"
done

VECTORS_SRC="$REPO_ROOT/spec/vectors"
VECTORS_DST="$PKG_DIR/test/conformance/vectors"

if [[ ! -d "$VECTORS_SRC" ]]; then
  echo "ERROR: $VECTORS_SRC not found — cannot include conformance vectors" >&2
  exit 1
fi

mkdir -p "$VECTORS_DST"
cp "$VECTORS_SRC"/*.json "$VECTORS_DST/"

VECTOR_COUNT=$(ls -1 "$VECTORS_DST"/*.json 2>/dev/null | wc -l | tr -d ' ')
echo "  copied README.md, LICENSE, SECURITY.md"
echo "  copied ${VECTOR_COUNT} conformance vectors to test/conformance/vectors/"
