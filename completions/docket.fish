# Tab completions for the docket binary.
# Symlinked to ~/.config/fish/completions/docket.fish (fish autoloads it there).
complete -c docket -f
complete -c docket -n __fish_use_subcommand -a poll -d 'one poll cycle (--dry-run to preview)'
complete -c docket -n __fish_use_subcommand -a sync -d 'refresh entries from GitHub'
complete -c docket -n __fish_use_subcommand -a review -d 'force-review a PR (key or URL)'
complete -c docket -n __fish_use_subcommand -a retry -d 're-run a failed review'
complete -c docket -n __fish_use_subcommand -a dismiss -d 'mark done + remove worktree'
complete -c docket -n __fish_use_subcommand -a doctor -d 'check setup: config, clones, gh, claude, plugin'
complete -c docket -n __fish_use_subcommand -a status -d 'poller state, live poll, state counts'
complete -c docket -n __fish_use_subcommand -a log -d 'last N log lines (default 20)'
complete -c docket -n __fish_use_subcommand -a watch -d 'follow the log live'
complete -c docket -n __fish_use_subcommand -a on -d 'enable the launchd poller'
complete -c docket -n __fish_use_subcommand -a off -d 'disable the launchd poller'
complete -c docket -n __fish_use_subcommand -a help -d 'show usage'
complete -c docket -n __fish_use_subcommand -s h -l help -d 'show usage'
complete -c docket -n '__fish_seen_subcommand_from poll' -l dry-run -d 'preview without starting reviews'
