#!/usr/bin/env bash
# Sets the Worker's secrets on Cloudflare. Run it after "source env.sh" and after the first deploy.
#   - TELEGRAM_BOT_TOKEN: you paste it when asked. It is never shown nor saved on disk.
#   - ALLOWED_USER_ID: the only Telegram user the bot listens to. If you don't know your ID,
#     the script finds it: you write to your bot and confirm that the sender is you.
#   - WEBHOOK_SECRET and AGENT_TOKEN are generated at random. AGENT_TOKEN is also saved in
#     secrets/agent_token (readable only by you), because sazed-agent needs it, and kept as it is
#     when the script runs again; WEBHOOK_SECRET is new every time, so the webhook is registered
#     again at once if the Worker's address is already known.
set -euo pipefail

SAZED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SAZED_DIR/worker"

if [ ! -f wrangler.jsonc ]; then
  echo "worker/wrangler.jsonc is missing: run scripts/configure.sh first." >&2
  exit 1
fi

# Calls the Telegram Bot API. The token travels through curl's configuration on stdin,
# so it never appears on the command line (visible to other processes).
telegram() {
  printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$BOT_TOKEN" "$1" | curl -sS -K -
}

echo "1/3  Bot token"
read -rsp "Paste the token @BotFather gave you and press Enter (it will not be shown): " BOT_TOKEN
echo
# A paste may carry spaces, a carriage return or the terminal's bracketed-paste markers.
BOT_TOKEN="${BOT_TOKEN//$'\e[200~'/}"
BOT_TOKEN="${BOT_TOKEN//$'\e[201~'/}"
BOT_TOKEN="$(printf '%s' "$BOT_TOKEN" | tr -d '[:space:]')"
if [ -z "$BOT_TOKEN" ]; then
  echo "Nothing was pasted. In some terminals pasting needs Ctrl+Shift+V or the right mouse button." >&2
  exit 1
fi
if ! [[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
  echo "This does not look like a bot token: it should read like 123456789:AA... (${#BOT_TOKEN} characters received)." >&2
  exit 1
fi
BOT_USERNAME="$(telegram getMe | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!r.ok) process.exit(1);
  console.log(r.result.username);
')" || { echo "Telegram does not accept this token." >&2; exit 1; }
echo "Token accepted: your bot is @$BOT_USERNAME."

echo
echo "2/3  Your Telegram user ID"
read -rp "Type it if you know it, or just press Enter to find it now: " USER_ID
USER_ID="$(printf '%s' "$USER_ID" | tr -d '[:space:]')"
if [ -z "$USER_ID" ]; then
  read -rp "Send any message to @$BOT_USERNAME from your Telegram account, then press Enter here. "
  # One line per sender in a private chat: id, then a description. "WEBHOOK" if Telegram
  # refuses because a webhook is already set. The messages are only read, not consumed: once
  # the webhook is set they reach the Worker, which keeps yours and drops everyone else's.
  SENDERS="$(telegram "getUpdates?timeout=0" | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (!r.ok) { console.log(r.error_code === 409 ? "WEBHOOK" : "ERROR " + r.description); process.exit(0); }
    const seen = new Map();
    for (const u of r.result) {
      const m = u.message;
      if (m?.chat?.type !== "private" || !m.from || seen.has(m.from.id)) continue;
      const f = m.from;
      seen.set(f.id, [f.first_name, f.last_name, f.username && "@" + f.username].filter(Boolean).join(" "));
    }
    for (const [id, who] of seen) console.log(id + "\t" + who);
  ')"
  case "$SENDERS" in
    WEBHOOK)
      echo "The bot already delivers its messages to a webhook, so they cannot be read here."
      echo "ALLOWED_USER_ID keeps its current value. To change it: npx wrangler secret put ALLOWED_USER_ID"
      ;;
    ERROR*)
      echo "Telegram answered: ${SENDERS#ERROR }" >&2
      exit 1
      ;;
    *)
      while IFS=$'\t' read -r id who <&3; do
        [ -n "$id" ] || continue
        read -rp "Message from $who (ID $id). Is this you? [y/N] " answer
        if [[ "$answer" =~ ^[yY] ]]; then USER_ID="$id"; break; fi
      done 3<<< "$SENDERS"
      if [ -z "$USER_ID" ]; then
        echo "No message from you yet: write to @$BOT_USERNAME and run the script again." >&2
        exit 1
      fi
      ;;
  esac
fi
if [ -n "$USER_ID" ] && ! [[ "$USER_ID" =~ ^[0-9]+$ ]]; then
  echo "A Telegram user ID is a number." >&2
  exit 1
fi

echo
echo "3/3  Uploading the secrets to Cloudflare"
mkdir -p "$SAZED_DIR/secrets"
chmod 700 "$SAZED_DIR/secrets"
if [ -s "$SAZED_DIR/secrets/agent_token" ]; then
  echo "secrets/agent_token already exists: reusing the same AGENT_TOKEN."
else
  ( umask 077; openssl rand -hex 32 | tr -d '\n' > "$SAZED_DIR/secrets/agent_token" )
fi
printf '%s' "$BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
if [ -n "$USER_ID" ]; then
  printf '%s' "$USER_ID" | npx wrangler secret put ALLOWED_USER_ID
fi
openssl rand -hex 32 | tr -d '\n' | npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put AGENT_TOKEN < "$SAZED_DIR/secrets/agent_token"

echo
if [ -s "$SAZED_DIR/secrets/worker_url" ]; then
  # Telegram must learn the new WEBHOOK_SECRET now: until then, the Worker refuses its calls.
  echo "Secrets set. Registering the webhook again, with the new secret:"
  "$SAZED_DIR/scripts/set-webhook.sh" "$(cat "$SAZED_DIR/secrets/worker_url")"
else
  echo "Secrets set. Now run: ../scripts/set-webhook.sh <your Worker's address>"
fi
