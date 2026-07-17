#!/usr/bin/env bash
# Idempotent setup: checks deps, seeds config, symlinks the fish frontend,
# and runs the mocked test suite.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

for dep in jq gh fish git; do
  command -v "$dep" >/dev/null || { echo "missing dependency: $dep" >&2; exit 1; }
done
command -v claude >/dev/null || echo "warning: claude CLI not found on PATH (needed at runtime)" >&2

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/auto-review"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/auto-review"
mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$HOME/.config/fish/functions" "$HOME/.config/fish/completions"

if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cp "$HERE/config.example.json" "$CONFIG_DIR/config.json"
  echo "seeded $CONFIG_DIR/config.json — edit it before enabling the poller"
fi

ln -sf "$HERE/fish/reviews.fish" "$HOME/.config/fish/functions/reviews.fish"
ln -sf "$HERE/fish/reviews-completions.fish" "$HOME/.config/fish/completions/reviews.fish"
echo "linked reviews function + completions into ~/.config/fish/"

bash "$HERE/tests/tests.sh"
echo "install complete — edit $CONFIG_DIR/config.json, then 'reviews on'"
