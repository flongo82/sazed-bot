#!/usr/bin/env bash
# Downloads the official Node.js 24 (LTS) from nodejs.org, verifies its checksum and
# extracts it into <project folder>/node. It does not touch the system.
set -euo pipefail

SAZED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="https://nodejs.org/dist/latest-v24.x"

case "$(uname -m)" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ -x "$SAZED_DIR/node/bin/node" ]; then
  echo "Node is already in $SAZED_DIR/node ($("$SAZED_DIR/node/bin/node" --version))."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
FILE="$(grep -o "node-v[0-9.]*-linux-$ARCH.tar.xz" "$TMP/SHASUMS256.txt" | head -n1)"
echo "Downloading $FILE from $BASE ..."
curl -fSL --progress-bar "$BASE/$FILE" -o "$TMP/$FILE"

( cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c - )

mkdir -p "$SAZED_DIR/node"
tar -xJf "$TMP/$FILE" -C "$SAZED_DIR/node" --strip-components=1
echo "Done: $("$SAZED_DIR/node/bin/node" --version) installed in $SAZED_DIR/node"
