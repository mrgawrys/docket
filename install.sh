#!/usr/bin/env bash
# Idempotent setup: checks deps, runs tests, builds the binary into
# ~/.local/bin, seeds config, links fish completions.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

for dep in bun gh git; do
  command -v "$dep" >/dev/null || { echo "missing dependency: $dep" >&2; exit 1; }
done
command -v claude >/dev/null || echo "warning: claude CLI not found on PATH (needed at runtime)" >&2

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/auto-review"
mkdir -p "$CONFIG_DIR" "$HOME/.local/bin" "$HOME/.config/fish/completions"

(cd "$HERE" && bun install && bun test && bun run build)
install -m 755 "$HERE/dist/reviews" "$HOME/.local/bin/reviews"

if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cp "$HERE/config.example.json" "$CONFIG_DIR/config.json"
  echo "seeded $CONFIG_DIR/config.json — edit it before enabling the poller"
fi

# the old fish *function* would shadow the binary — remove its symlink
rm -f "$HOME/.config/fish/functions/reviews.fish"
ln -sf "$HERE/fish/reviews-completions.fish" "$HOME/.config/fish/completions/reviews.fish"

echo "install complete — make sure ~/.local/bin is on PATH,"
echo "edit $CONFIG_DIR/config.json, then 'reviews on'"
