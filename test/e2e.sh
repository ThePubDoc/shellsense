#!/bin/sh
# End-to-end check of the zsh popup: runs a real zsh inside tmux, types, and reads the screen.
# Usage: test/e2e.sh        (needs tmux, zsh 5.9+, git)
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
command -v tmux >/dev/null || { echo "e2e: tmux is required" >&2; exit 2; }

# Kept short on purpose: a Unix socket path may not exceed about 100 bytes.
tmp=$(mktemp -d "${TMPDIR:-/tmp}/shellsense-e2e.XXXXXX")
export SHELLSENSE_SOCK="$tmp/sock"
tmux="tmux -L shellsense-e2e-$$"
cleanup() {
  $tmux kill-server 2>/dev/null
  "$root/bin/shellsense" stop >/dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT

mkdir -p "$tmp/home" "$tmp/work/src" "$tmp/work/docs"
(
  cd "$tmp/work" && git init -q -b main &&
    git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init &&
    git branch feature/login && : >"my file.txt"
) || exit 2
cat >"$tmp/home/.zshrc" <<RC
PS1='%# '
HISTFILE=$tmp/home/history
alias gco='git checkout'
bindkey -e
source $root/shell/shellsense.zsh
RC

$tmux new-session -d -x 100 -y 24 -c "$tmp/work" \
  "env -i HOME=$tmp/home ZDOTDIR=$tmp/home TERM=xterm-256color LANG=en_US.UTF-8 PATH=$PATH SHELLSENSE_SOCK=$SHELLSENSE_SOCK zsh -i"

keys() {
  $tmux send-keys "$@"
  sleep 0.5
}
screen() { $tmux capture-pane -p; }
prompt_line() { screen | grep -v '^ *$' | grep '^%' | tail -1; }
failed=0
pass() { echo "ok   $1"; }
fail() {
  echo "FAIL $1"
  failed=1
  screen | grep -v '^ *$' | sed 's/^/     | /'
}
shows() { if screen | grep -q -- "$2"; then pass "$1"; else fail "$1"; fi; }
hides() { if screen | grep -q -- "$2"; then fail "$1"; else pass "$1"; fi; }
line_is() { if [ "$(prompt_line)" = "$2" ]; then pass "$1"; else fail "$1 (line is: $(prompt_line))"; fi; }
wait_for_engine() {
  i=0
  while [ $i -lt 40 ] && ! "$root/bin/shellsense" status >/dev/null 2>&1; do
    sleep 0.25
    i=$((i + 1))
  done
}

# The first prompt starts the engine; give it time to come up before typing.
wait_for_engine
keys 'git che'
shows "popup lists the matching subcommands" 'cherry-pick  *Apply'
keys Tab
line_is "Tab inserts the first row" '% git checkout'
shows "a generator fills the next popup with branches" 'feature/login  *Branch'
keys Down
keys Enter
line_is "Enter inserts the row picked with the arrows" '% git checkout feature/login'
shows "and does not run the command" 'Quiet, suppress'
keys C-c
hides "Ctrl-C leaves no popup behind" 'Quiet, suppress'

keys 'gco fea'
shows "aliases are expanded" 'feature/login  *Branch'
keys Escape
hides "Esc closes the popup" 'Branch'
keys 'ture'
hides "and it stays closed for the rest of that word" 'Branch'

keys C-u
keys 'cat my'
keys Tab
line_is "file names are escaped on insert" '% cat my\ file.txt'

keys C-u
keys 'echo one' Enter
keys 'git st'
shows "popup is open before pressing Up" 'Show the working tree status'
keys Up
hides "Up closes a popup that was not navigated" 'Show the working tree status'
line_is "and recalls history as usual" '% echo one'

keys C-u
"$root/bin/shellsense" stop >/dev/null
sleep 5 # the shell starts the engine at most once every five seconds
keys 'git st'
wait_for_engine
keys a
shows "the engine is restarted after it dies" 'stash  *Temporarily'
keys Enter
line_is "Enter inserts the highlighted row of a half-typed word" '% git stage'
keys C-u

keys 'ls doc'
keys Enter
line_is "the same for a path" '% ls docs/'
keys C-u
keys 'ls docs'
shows "popup is open on a complete word" 'docs/'
keys Enter
hides "Enter runs the line when the word is already complete" 'docs/ '
line_is "and a fresh prompt follows" '%'
mkdir -p "$tmp/work/src/lib"
keys 'cd sr'
keys Enter
line_is "Enter completes a half-typed folder" '% cd src/'
shows "and the first row is the folder itself" '● \.  *src/'
keys Enter
keys 'pwd' Enter
shows "Enter on that row changes into the folder" "work/src\$"
keys 'cd ..' Enter
keys 'cd '
shows "popup is open with no word started" 'docs/'
keys Enter
line_is "Enter takes the top row even when no word has been started" '% cd docs/'
keys C-u

[ $failed -eq 0 ] && echo "all end-to-end checks passed"
exit $failed
