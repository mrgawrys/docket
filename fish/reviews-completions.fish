# Tab completions for the reviews command.
# Symlinked to ~/.config/fish/completions/reviews.fish (fish autoloads it there).
complete -c reviews -f
complete -c reviews -n __fish_use_subcommand -a status -d 'poller state, live poll, state counts'
complete -c reviews -n __fish_use_subcommand -a log -d 'last N log lines (default 20)'
complete -c reviews -n __fish_use_subcommand -a watch -d 'follow the log live'
complete -c reviews -n __fish_use_subcommand -a on -d 'enable the launchd poller'
complete -c reviews -n __fish_use_subcommand -a off -d 'disable the launchd poller'
complete -c reviews -n __fish_use_subcommand -a help -d 'show usage'
