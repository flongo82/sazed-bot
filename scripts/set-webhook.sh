#!/usr/bin/env bash
# Asks the Worker to register itself with Telegram as the bot's webhook.
# Usage: scripts/set-webhook.sh https://<worker-name>.<your-subdomain>.workers.dev
set -euo pipefail

SAZED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${1:-}"
if [ -z "$URL" ]; then
  echo "Usage: $0 https://<worker-name>.<your-subdomain>.workers.dev" >&2
  echo "(the address printed by 'npx wrangler deploy')" >&2
  exit 1
fi
if [ ! -s "$SAZED_DIR/secrets/agent_token" ]; then
  echo "secrets/agent_token is missing: run scripts/setup-secrets.sh first." >&2
  exit 1
fi
URL="${URL%/}"
( umask 077; echo "$URL" > "$SAZED_DIR/secrets/worker_url" )

# The agent token travels through curl's configuration on stdin, never on the command line.
STATUS=0
RESPONSE="$(printf 'header = "Authorization: Bearer %s"\n' "$(cat "$SAZED_DIR/secrets/agent_token")" \
  | curl -sS --fail-with-body -X POST "$URL/setup" -K -)" || STATUS=$?
if [ -n "$RESPONSE" ]; then
  python3 -m json.tool <<< "$RESPONSE" 2>/dev/null || echo "$RESPONSE"
fi
if [ "$STATUS" -ne 0 ]; then
  echo "The Worker refused. A 404 means a wrong address, or an agent token different from" >&2
  echo "the one on Cloudflare; any other answer is shown above." >&2
  exit 1
fi
echo
echo "If you see \"ok\": true above, send /stato to your bot."
