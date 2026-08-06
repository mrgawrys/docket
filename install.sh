#!/usr/bin/env bash
# Idempotent setup: checks deps, runs tests, builds the binary into
# ~/.local/bin, links the shell completions. The binary seeds its own config.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

for dep in bun gh git; do
  command -v "$dep" >/dev/null || { echo "missing dependency: $dep" >&2; exit 1; }
done
command -v claude >/dev/null || echo "warning: claude CLI not found on PATH (needed at runtime)" >&2

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
FISH_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions"
BASH_DIR="$DATA_HOME/bash-completion/completions"
ZSH_DIR="$DATA_HOME/zsh/site-functions"
mkdir -p "$HOME/.local/bin" "$FISH_DIR" "$BASH_DIR" "$ZSH_DIR"

(cd "$HERE" && bun install && bun test && bun run build)
install -m 755 "$HERE/dist/docket" "$HOME/.local/bin/docket"

ln -sf "$HERE/completions/docket.fish" "$FISH_DIR/docket.fish"
ln -sf "$HERE/completions/docket.bash" "$BASH_DIR/docket"
ln -sf "$HERE/completions/_docket" "$ZSH_DIR/_docket"

# fish and bash-completion autoload their dirs; zsh has no user-level
# convention, so say so once when ours isn't already on the fpath.
if command -v zsh >/dev/null &&
  ! zsh -ic 'print -l -- $fpath' 2>/dev/null | grep -qxF "$ZSH_DIR"; then
  echo "zsh: add to ~/.zshrc before compinit — fpath=($ZSH_DIR \$fpath)"
fi

# Leftovers from when this was called auto-review: its binary is gone, its
# completions would complete a command that no longer exists, and its launchd
# job would keep polling with a missing binary. (The old fish *function*
# shadowed the binary back then — remove that too.)
rm -f "$HOME/.local/bin/reviews" \
  "$FISH_DIR/reviews.fish" \
  "${XDG_CONFIG_HOME:-$HOME/.config}/fish/functions/reviews.fish"
OLD_JOB="com.$(id -un).auto-review"
HAD_POLLER=0
# `if`, not `&&`: a failing left-hand side of an AND list trips `set -e`
if launchctl print "gui/$(id -u)/$OLD_JOB" >/dev/null 2>&1; then HAD_POLLER=1; fi
launchctl bootout "gui/$(id -u)/$OLD_JOB" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$OLD_JOB.plist"

# Tearing the old job down would otherwise leave a working install silently not
# polling, which reads exactly like an empty queue.
if [ "$HAD_POLLER" = 1 ]; then
  echo "the old poller was loaded — re-enabling it under the new name"
  "$HOME/.local/bin/docket" on ||
    echo "could not re-enable it — run 'docket doctor', then 'docket on'" >&2
fi

echo "install complete — make sure ~/.local/bin is on PATH,"
echo "run 'docket doctor' (it writes a starter config to edit), then 'docket on'"
