# Tab completions for the docket binary.
# Symlinked as docket into bash-completion's user dir,
# ${XDG_DATA_HOME:-~/.local/share}/bash-completion/completions.

_docket() {
  local cur commands
  cur=${COMP_WORDS[COMP_CWORD]}
  commands='poll sync review retry dismiss doctor status log watch on off help'

  if [ "$COMP_CWORD" -eq 1 ]; then
    case $cur in
      -*) COMPREPLY=($(compgen -W '-h --help' -- "$cur")) ;;
      *) COMPREPLY=($(compgen -W "$commands" -- "$cur")) ;;
    esac
    return
  fi

  # Everything else takes a PR key, a note or a line count — free-form, so
  # offer nothing rather than falling back to filenames.
  case ${COMP_WORDS[1]} in
    poll) COMPREPLY=($(compgen -W '--dry-run' -- "$cur")) ;;
    *) COMPREPLY=() ;;
  esac
}

complete -F _docket docket
