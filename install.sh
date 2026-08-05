#!/usr/bin/env bash
# Idempotent setup: checks deps, runs tests, builds the binary into
# ~/.local/bin, links fish completions. The binary seeds its own config.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

for dep in bun gh git; do
  command -v "$dep" >/dev/null || { echo "missing dependency: $dep" >&2; exit 1; }
done
command -v claude >/dev/null || echo "warning: claude CLI not found on PATH (needed at runtime)" >&2

mkdir -p "$HOME/.local/bin" "$HOME/.config/fish/completions"

(cd "$HERE" && bun install && bun test && bun run build)
install -m 755 "$HERE/dist/docket" "$HOME/.local/bin/docket"

ln -sf "$HERE/fish/docket-completions.fish" "$HOME/.config/fish/completions/docket.fish"

# Leftovers from when this was called auto-review: its binary is gone, its
# completions would complete a command that no longer exists, and its launchd
# job would keep polling with a missing binary. (The old fish *function*
# shadowed the binary back then — remove that too.)
rm -f "$HOME/.local/bin/reviews" \
  "$HOME/.config/fish/completions/reviews.fish" \
  "$HOME/.config/fish/functions/reviews.fish"
OLD_JOB="com.$(id -un).auto-review"
launchctl bootout "gui/$(id -u)/$OLD_JOB" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$OLD_JOB.plist"

echo "install complete — make sure ~/.local/bin is on PATH,"
echo "run 'docket doctor' (it writes a starter config to edit), then 'docket on'"
