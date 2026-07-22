# Tab completions for the reviews binary.
# Symlinked to ~/.config/fish/completions/reviews.fish (fish autoloads it there).
complete -c reviews -f
complete -c reviews -n __fish_use_subcommand -a poll -d 'one poll cycle (--dry-run to preview)'
complete -c reviews -n __fish_use_subcommand -a sync -d 'refresh entries from GitHub'
complete -c reviews -n __fish_use_subcommand -a review -d 'force-review a PR (key or URL)'
complete -c reviews -n __fish_use_subcommand -a retry -d 're-run a failed review'
complete -c reviews -n __fish_use_subcommand -a dismiss -d 'mark done + remove worktree'
complete -c reviews -n __fish_use_subcommand -a doctor -d 'check setup: config, clones, gh, claude, plugin'
complete -c reviews -n __fish_use_subcommand -a status -d 'poller state, live poll, state counts'
complete -c reviews -n __fish_use_subcommand -a log -d 'last N log lines (default 20)'
complete -c reviews -n __fish_use_subcommand -a watch -d 'follow the log live'
complete -c reviews -n __fish_use_subcommand -a on -d 'enable the launchd poller'
complete -c reviews -n __fish_use_subcommand -a off -d 'disable the launchd poller'
complete -c reviews -n __fish_use_subcommand -a help -d 'show usage'
