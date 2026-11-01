#!/usr/bin/env bash
# Creates worker/wrangler.jsonc, your personal configuration, from worker/wrangler.example.jsonc.
# It asks for the name your bot introduces itself with and the language of its messages, and
# gives the Worker a name with a random suffix so that its address cannot be guessed.
# wrangler.jsonc is ignored by git.
set -euo pipefail

SAZED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$SAZED_DIR/worker/wrangler.example.jsonc"
CONFIG="$SAZED_DIR/worker/wrangler.jsonc"

if [ -e "$CONFIG" ]; then
  echo "worker/wrangler.jsonc already exists, and stays as it is:"
  grep -E '^  "name"|"BOT_NAME"|"LANGUAGE"' "$CONFIG"
  echo "Renaming a deployed Worker creates a new one, with an empty queue."
  echo "To change the name or the language: edit the file, run 'npx wrangler deploy' in worker/,"
  echo "then scripts/set-webhook.sh again, which also updates the command menu."
  exit 0
fi

read -rp "The name your bot introduces itself with [sazed]: " BOT_NAME
BOT_NAME="${BOT_NAME:-sazed}"
case "$BOT_NAME" in
  *[\"\\]*) echo "The name cannot contain quotes or backslashes." >&2; exit 1 ;;
esac

# The languages are the blocks of the text catalog: adding a block there adds a choice here.
LANGS="$(grep -oE '^  [a-z]{2}: \{' "$SAZED_DIR/worker/src/messages.js" | cut -c3-4 | tr '\n' ' ')"
LANGS="${LANGS% }"
read -rp "Language of its messages: auto (the one of your Telegram app) or one of: $LANGS [auto]: " LANGUAGE
LANGUAGE="$(printf '%s' "${LANGUAGE:-auto}" | tr '[:upper:]' '[:lower:]')"
if [[ " auto $LANGS " != *" $LANGUAGE "* ]]; then
  echo "The language must be auto or one of: $LANGS." >&2
  exit 1
fi

# Worker name: lowercase letters, digits and hyphens, plus 8 random hex characters.
SLUG="$(printf '%s' "$BOT_NAME" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' \
  | sed -E 's/-+/-/g; s/^-//; s/-$//')"
WORKER_NAME="${SLUG:0:40}"
WORKER_NAME="${WORKER_NAME%-}"
WORKER_NAME="${WORKER_NAME:-bot}-$(openssl rand -hex 4)"

BOT_NAME_SED="$(printf '%s' "$BOT_NAME" | sed 's/[&/|]/\\&/g')"
sed -e "s|\"name\": \"sazed-bot\"|\"name\": \"$WORKER_NAME\"|" \
    -e "s|\"BOT_NAME\": \"sazed\"|\"BOT_NAME\": \"$BOT_NAME_SED\"|" \
    -e "s|\"LANGUAGE\": \"auto\"|\"LANGUAGE\": \"$LANGUAGE\"|" \
    "$TEMPLATE" > "$CONFIG"

if ! grep -qF "\"name\": \"$WORKER_NAME\"" "$CONFIG" || ! grep -qF "\"BOT_NAME\": \"$BOT_NAME\"" "$CONFIG" \
    || ! grep -qF "\"LANGUAGE\": \"$LANGUAGE\"" "$CONFIG"; then
  rm -f "$CONFIG"
  echo "Could not write the configuration: has wrangler.example.jsonc changed?" >&2
  exit 1
fi

echo "Done: worker/wrangler.jsonc"
echo "  Worker name:  $WORKER_NAME"
echo "  Bot name:     $BOT_NAME"
echo "  Language:     $LANGUAGE"
