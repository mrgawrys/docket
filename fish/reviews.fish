function reviews --description "List/resume pre-run PR reviews; status|log|watch|on|off control the poller"
    # this file is autoloaded via a symlink into the repo checkout — resolve
    # it to find the repo, so the checkout can live anywhere
    set -l fnfile (status filename)
    test -L $fnfile; and set fnfile (readlink $fnfile)
    set -l repo (dirname (dirname $fnfile))

    set -l config_dir $HOME/.config/auto-review
    set -q XDG_CONFIG_HOME; and set config_dir $XDG_CONFIG_HOME/auto-review
    set -q AUTO_REVIEW_CONFIG_DIR; and set config_dir $AUTO_REVIEW_CONFIG_DIR
    set -l state_dir $HOME/.local/state/auto-review
    set -q XDG_STATE_HOME; and set state_dir $XDG_STATE_HOME/auto-review
    set -q AUTO_REVIEW_STATE_DIR; and set state_dir $AUTO_REVIEW_STATE_DIR

    set -l state $state_dir/state.json
    set -l logfile $state_dir/auto-review.log
    set -l label com.(whoami).auto-review
    set -l plist ~/Library/LaunchAgents/$label.plist

    switch "$argv[1]"
        case help -h --help
            echo "reviews            interactive list: resume #, d# dismiss, r# retry, q quit"
            echo "reviews status     launchd state, live poll, last activity, state counts"
            echo "reviews log [N]    last N log lines (default 20)"
            echo "reviews watch      follow the log live (Ctrl+C to stop)"
            echo "reviews on         enable the launchd poller (interval from config)"
            echo "reviews off        disable the launchd poller (manual runs still work)"
            return 0
        case status
            if launchctl print gui/(id -u)/$label >/dev/null 2>&1
                echo "poller:  ON (launchd) — 'reviews off' to disable"
            else
                echo "poller:  OFF — 'reviews on' to enable, or run bin/auto-review manually"
            end
            set -l lockpid (cat $state_dir/.lock/pid 2>/dev/null)
            if test -n "$lockpid"; and kill -0 $lockpid 2>/dev/null
                echo "poll:    running right now (pid $lockpid)"
            end
            if test -f $state
                echo "state:   "(jq -r '[.[] | .status] | if length == 0 then "empty"
                    else group_by(.) | map("\(length) \(.[0])") | join(", ") end' $state)
            end
            echo "log:     last lines of $logfile"
            tail -n 3 $logfile 2>/dev/null | sed 's/^/         /'
            return 0
        case log
            set -l n 20
            test -n "$argv[2]"; and set n $argv[2]
            tail -n $n $logfile
            return 0
        case watch
            tail -f $logfile
            return 0
        case on
            if not test -f $repo/launchd.plist.template
                echo "missing $repo/launchd.plist.template"
                return 1
            end
            set -l minutes (jq -r '.poll_interval_minutes // 15' $config_dir/config.json 2>/dev/null)
            test -n "$minutes"; or set minutes 15
            set -l interval (math "$minutes * 60")
            mkdir -p $state_dir
            # the generated plist bakes in machine-specific absolute paths,
            # so it lives only in ~/Library/LaunchAgents — never in the repo
            sed -e "s|__LABEL__|$label|g" -e "s|__BIN__|$repo/bin/auto-review|g" \
                -e "s|__INTERVAL__|$interval|g" -e "s|__STATE_DIR__|$state_dir|g" \
                -e "s|__HOME__|$HOME|g" $repo/launchd.plist.template >$plist
            and plutil -lint $plist >/dev/null
            or begin
                echo "plist generation failed"
                rm -f $plist
                return 1
            end
            launchctl bootout gui/(id -u)/$label 2>/dev/null
            launchctl bootstrap gui/(id -u) $plist
            and echo "poller enabled as $label — polls every $minutes min (RunAtLoad fired one now)"
            return $status
        case off
            launchctl bootout gui/(id -u)/$label 2>/dev/null
            and echo "poller disabled — 'reviews on' re-enables, manual runs still work"
            or echo "poller was not loaded"
            rm -f $plist
            return 0
        case '*'
            if test -n "$argv[1]"
                echo "unknown subcommand: $argv[1] (try: reviews help)"
                return 1
            end
    end

    if not test -f $state
        echo "no state file: $state"
        return 1
    end
    set -l lockpid (cat $state_dir/.lock/pid 2>/dev/null)
    if test -n "$lockpid"; and kill -0 $lockpid 2>/dev/null
        set -l cur (jq -r 'to_entries[] | select(.value.status == "reviewing") | .key' $state \
            | string join ", ")
        if test -n "$cur"
            echo "⏳ poll running (pid $lockpid) — reviewing: $cur"
        else
            echo "⏳ poll running (pid $lockpid)"
        end
    end
    set -l keys (jq -r 'to_entries | map(select(.value.status != "done"))
                        | sort_by(.value.updated_at) | .[].key' $state)
    if test (count $keys) -eq 0
        echo "No pending reviews."
        return 0
    end
    for i in (seq (count $keys))
        set -l line (jq -r --arg k $keys[$i] \
            '.[$k] | "[\(.status)]\t\(.title)\t\(.updated_at)"' $state)
        printf '%2d  %-32s %s\n' $i $keys[$i] "$line"
    end
    read -l -P 'resume #  (d# dismiss, r# retry, q quit): ' choice
    if test -z "$choice"; or test "$choice" = q
        return 0
    end
    set -l action resume
    switch $choice
        case 'd*'
            set action dismiss
            set choice (string sub -s 2 $choice)
        case 'r*'
            set action retry
            set choice (string sub -s 2 $choice)
    end
    if not string match -qr '^[0-9]+$' -- $choice
        echo "bad choice"
        return 1
    end
    if test $choice -lt 1; or test $choice -gt (count $keys)
        echo "bad choice"
        return 1
    end
    set -l key $keys[$choice]
    switch $action
        case resume
            set -l st (jq -r --arg k $key '.[$k].status' $state)
            if test "$st" = reviewing
                echo "$key is still being reviewed — wait for the notification, then rerun reviews"
                return 1
            end
            set -l sid (jq -r --arg k $key '.[$k].session_id // empty' $state)
            set -l path (jq -r --arg k $key '.[$k].local_path // empty' $state)
            if test -z "$sid"; or test -z "$path"
                echo "$key has no session ($st) — use r$choice to (re)run the review"
                return 1
            end
            set -l claude_bin (jq -r '.claude_bin // "claude"' $config_dir/config.json 2>/dev/null)
            test -n "$claude_bin"; or set claude_bin claude
            set -l claude_home (jq -r '.claude_config_dir // empty' $config_dir/config.json 2>/dev/null)
            if test -n "$claude_home"
                cd $path; and env CLAUDE_CONFIG_DIR=$claude_home $claude_bin --resume $sid
            else
                cd $path; and $claude_bin --resume $sid
            end
        case dismiss
            set -l path (jq -r --arg k $key '.[$k].local_path // empty' $state)
            set -l tmp (mktemp)
            jq --arg k $key '.[$k].status = "done"' $state >$tmp; and mv $tmp $state
            set -l num (string split '#' $key)[2]
            if test -n "$path"; and test -d "$path/.worktrees/pr-$num"
                git -C $path worktree remove --force ".worktrees/pr-$num"
                and echo "removed worktree $path/.worktrees/pr-$num"
            end
            echo "dismissed $key"
        case retry
            bash $repo/bin/auto-review --retry $key
    end
end
