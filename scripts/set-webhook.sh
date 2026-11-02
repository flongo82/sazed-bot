#!/usr/bin/env bash
# Asks the Worker to register itself with Telegram as the bot's webhook, and checks that
# Telegram now delivers there. Saves the address in secrets/worker_url only once it works.
# Usage: scripts/set-webhook.sh https://<worker-name>.<your-subdomain>.workers.dev
set -euo pipefail

SAZED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${1:-}"
if [ -z "$URL" ]; then
  echo "Usage: $0 https://<worker-name>.<your-subdomain>.workers.dev" >&2
  echo "(the address printed by 'npx wrangler deploy')" >&2
  exit 1
fi
URL="${URL%/}"
# The agent token is sent to this address: never in clear text.
if [[ "$URL" != https://* ]]; then
  echo "The Worker's address must start with https:// (the agent token is sent to it)." >&2
  exit 1
fi
if [ ! -s "$SAZED_DIR/secrets/agent_token" ]; then
  echo "secrets/agent_token is missing: run scripts/setup-secrets.sh first." >&2
  exit 1
fi

# The agent token travels through curl's configuration on stdin, never on the command line.
OUTPUT="$(printf 'header = "Authorization: Bearer %s"\n' "$(cat "$SAZED_DIR/secrets/agent_token")" \
  | curl -sS -X POST "$URL/setup" -K - -w '\n%{http_code}')" \
  || { echo "Cannot reach $URL." >&2; exit 1; }
CODE="${OUTPUT##*$'\n'}"
BODY="${OUTPUT%$'\n'*}"
if [ "$CODE" != 200 ] && [ -n "$BODY" ]; then
  python3 -m json.tool <<< "$BODY" 2>/dev/null || echo "$BODY"
fi
case "$CODE" in
  200) ;;
  404) echo "The Worker refused: a wrong address, or an agent token different from the one on Cloudflare." >&2; exit 1 ;;
  400) echo "Some secrets are missing on Cloudflare (see above): run scripts/setup-secrets.sh." >&2; exit 1 ;;
  502) echo "Telegram did not register the webhook (see above). Try again in a moment." >&2; exit 1 ;;
  *) echo "Unexpected answer from the Worker (HTTP $CODE)." >&2; exit 1 ;;
esac

( umask 077; echo "$URL" > "$SAZED_DIR/secrets/worker_url" )
if python3 -c 'import json, sys; sys.exit(0 if json.load(sys.stdin).get("commands") else 1)' <<< "$BODY"; then
  echo "Webhook registered and checked, command menu updated: send /stato to your bot."
else
  echo "Webhook registered and checked, but Telegram did not update the command menu:"
  echo "the bot works; run this script again later to fix the menu."
fi
