# Project environment. Use it with:  source env.sh
# Keeps Node, the npm cache and wrangler's configuration (login included) inside this
# folder: deleting it uninstalls everything.

SAZED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SAZED_DIR
export PATH="$SAZED_DIR/node/bin:$PATH"
export XDG_CONFIG_HOME="$SAZED_DIR/.config"
export npm_config_cache="$SAZED_DIR/.npm-cache"
export npm_config_update_notifier=false
export WRANGLER_SEND_METRICS=false

if command -v node >/dev/null 2>&1; then
  echo "sazed-bot environment ready (node $(node --version))."
else
  echo "sazed-bot environment ready, but Node is missing: run scripts/install-node.sh"
fi
