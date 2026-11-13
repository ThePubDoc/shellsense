# shellsense — autocomplete popup drawn inside the terminal, below the command line.
#
# Add to ~/.zshrc:   source /path/to/shellsense/shell/shellsense.zsh
#
# How it works: after every edit the line editor sends the buffer and cursor to the engine over a
# Unix socket. The engine answers asynchronously with rows, which are shown through POSTDISPLAY —
# zsh's own mechanism for text after the buffer — so zsh does all the scrolling and redrawing.
# While the popup is open, Tab, Enter, Esc and the arrow keys are bound to it; when it closes the
# previous bindings come back, so nothing changes for a line that has no popup.

[[ -o interactive ]] || return 0
autoload -Uz is-at-least add-zle-hook-widget
if ! is-at-least 5.9; then
  print -u2 "shellsense: zsh 5.9 or later is required (this is $ZSH_VERSION)"
  return 0
fi
zmodload zsh/net/socket zsh/datetime zsh/parameter 2>/dev/null || return 0
zmodload -F zsh/files b:zf_rm 2>/dev/null

# ---- settings (set any of these before sourcing) -------------------------------------------

: ${SHELLSENSE_HOME:=${${(%):-%x}:A:h:h}}
: ${SHELLSENSE_SOCK:=${XDG_STATE_HOME:-$HOME/.local/state}/shellsense/sock}
: ${SHELLSENSE_NODE:=node}
: ${SHELLSENSE_MAX_ROWS:=8}
# "insert": Enter inserts the highlighted row while a word is being typed. "run": Enter always
# runs the line unless a row was picked with the arrow keys.
: ${SHELLSENSE_ENTER:=insert}
: ${SHELLSENSE_ICONS:=auto}      # auto | nerd | dots | none   (auto = nerd when powerlevel10k says a Nerd Font is in use)
: ${SHELLSENSE_THEME:=auto}      # auto | dark | light         (auto = shades derived from the terminal's own colours)
: ${SHELLSENSE_ACCENT:=4}        # colour of the selection bar and of the typed characters; 4 is the theme's blue
: ${SHELLSENSE_BOX:=rounded}     # rounded = outlined box | card = outlined and filled | flat = filled panel, no outline
: ${SHELLSENSE_HINTS:=1}         # 1 = the bottom edge says what Enter will do and where you are in the list
: ${SHELLSENSE_PADDING:=1}       # flat only: 1 = half-height padding above and below the list
# Any of these overrides one shade of the theme. Values are zsh colours: 0-255 or #rrggbb.
#   SHELLSENSE_COLOR_PANEL  SHELLSENSE_COLOR_SELECTED  SHELLSENSE_COLOR_DIM  SHELLSENSE_COLOR_THUMB  SHELLSENSE_COLOR_BORDER

# ---- state ---------------------------------------------------------------------------------

typeset -g _shellsense_us=$'\x1f' _shellsense_rs=$'\x1e' _shellsense_gs=$'\x1d'
typeset -g _shellsense_fd=${_shellsense_fd:-} _shellsense_last= _shellsense_post=
typeset -gi _shellsense_retry=0 _shellsense_seq=0 _shellsense_got=0 _shellsense_naliases=-1
typeset -gi _shellsense_visible=0 _shellsense_bound=0 _shellsense_nav=0 _shellsense_sel=1 _shellsense_top=1
typeset -gi _shellsense_rstart=0 _shellsense_dismissed=-1 _shellsense_namew=0 _shellsense_descw=0 _shellsense_complete=0
# Screen column where the buffer starts, learned from the terminal once per prompt; -1 = unknown.
typeset -gi _shellsense_basecol=-1 _shellsense_asked=0 _shellsense_askw=0 _shellsense_keytimeout=0
typeset -ga _shellsense_display _shellsense_desc _shellsense_kind _shellsense_insert _shellsense_back
typeset -ga _shellsense_mstart _shellsense_mlen
# Look: the four shades, the terminal's colours as "r g b" once known, and icon and tint per kind.
typeset -g _shellsense_c_panel= _shellsense_c_sel= _shellsense_c_dim= _shellsense_c_thumb= _shellsense_c_border=
typeset -g _shellsense_bg_rgb=${_shellsense_bg_rgb:-} _shellsense_fg_rgb=${_shellsense_fg_rgb:-} _shellsense_accent_rgb=${_shellsense_accent_rgb:-}
typeset -gi _shellsense_asked_colors=0
typeset -gA _shellsense_glyph _shellsense_tint
typeset -gA _shellsense_orig _shellsense_keys
_shellsense_keys=(
  $'\t'   shellsense-accept
  $'\r'   shellsense-enter
  $'\e'   shellsense-dismiss
  $'\e[A' shellsense-up    $'\eOA' shellsense-up
  $'\e[B' shellsense-down  $'\eOB' shellsense-down
)

# ---- connection to the engine --------------------------------------------------------------

_shellsense_send() {
  [[ -n $_shellsense_fd ]] || return 1
  print -r -u $_shellsense_fd -- "$1" 2>/dev/null || { _shellsense_close; return 1 }
}

_shellsense_close() {
  [[ -n $_shellsense_fd ]] || return 0
  zle -F $_shellsense_fd 2>/dev/null
  exec {_shellsense_fd}>&-
  _shellsense_fd=
  _shellsense_hide
}

_shellsense_hello() {
  local name
  local -a pairs
  for name in ${(k)aliases}; do
    pairs+=("$name=${aliases[$name]//[$'\n\x1d\x1e\x1f']/ }")
  done
  _shellsense_naliases=${#aliases}
  _shellsense_send "H${_shellsense_us}$$${_shellsense_us}${PATH}${_shellsense_us}${(pj:\x1e:)pairs}"
}

_shellsense_connect() {
  [[ -n $_shellsense_fd ]] && return 0
  local REPLY
  if ! zsocket $SHELLSENSE_SOCK 2>/dev/null; then
    # Trying the socket costs nothing, so every keystroke may try; starting the engine is what
    # gets rate-limited. It detaches itself, and the first keystroke after it is up connects.
    if [[ -z $SHELLSENSE_NO_AUTOSTART ]] && (( EPOCHSECONDS >= _shellsense_retry )); then
      _shellsense_retry=$(( EPOCHSECONDS + 5 ))
      ( SHELLSENSE_SOCK=$SHELLSENSE_SOCK SHELLSENSE_NODE=$SHELLSENSE_NODE $SHELLSENSE_HOME/bin/shellsense daemon </dev/null &>/dev/null & )
    fi
    return 1
  fi
  _shellsense_fd=$REPLY
  zle -F -w $_shellsense_fd _shellsense_recv
  _shellsense_hello
}

# Called by zle whenever the engine has written something.
_shellsense_recv() {
  local fd=$1 line
  if [[ -n $2 ]] || ! IFS= read -r -u $fd line; then
    if [[ $fd == $_shellsense_fd ]]; then
      _shellsense_close
    else
      zle -F $fd 2>/dev/null
      exec {fd}>&-
    fi
    zle -R
    return 0
  fi
  _shellsense_handle $line
  # The first reply of a line is a good moment to learn the cursor column: the screen is in sync.
  (( _shellsense_visible && _shellsense_basecol < 0 && ! _shellsense_asked )) && _shellsense_ask
  zle -R
}

_shellsense_handle() {
  emulate -L zsh
  local -a records head f
  records=("${(@ps:\x1e:)1}")
  head=("${(@ps:\x1f:)records[1]}")
  [[ $head[1] == R ]] && (( head[2] == _shellsense_seq )) || return 0
  _shellsense_got=$head[2]

  local -i count=$(( $#records - 1 )) i w
  if (( count == 0 )); then
    # A partial answer with nothing in it says nothing yet; only the final one closes the popup.
    (( head[3] )) && _shellsense_hide
    return 0
  fi
  (( head[4] == _shellsense_dismissed )) && return 0
  _shellsense_dismissed=-1

  # Keep the highlighted row across refreshes once the user has started to navigate.
  local keep=
  (( _shellsense_visible && _shellsense_nav )) && keep=$_shellsense_insert[_shellsense_sel]

  _shellsense_display=() _shellsense_desc=() _shellsense_kind=() _shellsense_insert=() _shellsense_back=()
  _shellsense_mstart=() _shellsense_mlen=()
  _shellsense_namew=0 _shellsense_descw=0
  for (( i = 2; i <= $#records; i++ )); do
    f=("${(@ps:\x1f:)records[i]}")
    _shellsense_display+=("$f[1]") _shellsense_desc+=("$f[2]") _shellsense_kind+=("$f[3]")
    _shellsense_insert+=("$f[4]") _shellsense_back+=("${f[5]:-0}")
    _shellsense_mstart+=("${f[6]:-0}") _shellsense_mlen+=("${f[7]:-0}")
    w=${(m)#f[1]}; (( w > _shellsense_namew )) && _shellsense_namew=$w
    w=${(m)#f[2]}; (( w > _shellsense_descw )) && _shellsense_descw=$w
  done
  _shellsense_rstart=$head[4]
  _shellsense_complete=${head[5]:-0}
  _shellsense_sel=1 _shellsense_top=1
  if [[ -n $keep ]]; then
    i=${_shellsense_insert[(Ie)$keep]}
    if (( i )); then _shellsense_sel=$i; else _shellsense_nav=0; fi
  else
    _shellsense_nav=0
  fi

  if (( ! _shellsense_visible )); then
    _shellsense_visible=1
    _shellsense_bind
  fi
  _shellsense_render
}

_shellsense_query() {
  _shellsense_connect || return 1
  _shellsense_seq+=1
  _shellsense_send "Q${_shellsense_us}${_shellsense_seq}${_shellsense_us}${CURSOR}${_shellsense_us}${PWD}${_shellsense_us}${BUFFER//$'\n'/$_shellsense_gs}"
}

# Drops whatever answer is still on its way and closes the popup.
_shellsense_cancel() {
  _shellsense_seq+=1
  _shellsense_got=$_shellsense_seq
  _shellsense_hide
}

# Makes sure the rows belong to the buffer as it is right now, waiting briefly for the engine if
# the user was faster than the reply. Returns 0 when there is something to accept.
_shellsense_await() {
  local state="$CURSOR$_shellsense_us$BUFFER" line
  if [[ $state != "$_shellsense_last" ]]; then
    _shellsense_last=$state
    _shellsense_query || return 1
  fi
  local -F deadline=$(( EPOCHREALTIME + 0.3 ))
  while (( _shellsense_got != _shellsense_seq && EPOCHREALTIME < deadline )); do
    IFS= read -r -t 0.3 -u $_shellsense_fd line || break
    _shellsense_handle $line
  done
  (( _shellsense_visible && _shellsense_got == _shellsense_seq ))
}

# ---- drawing -------------------------------------------------------------------------------

_shellsense_render() {
  emulate -L zsh
  local -i n=$#_shellsense_insert
  local -i rows=$(( n < SHELLSENSE_MAX_ROWS ? n : SHELLSENSE_MAX_ROWS ))
  (( rows > 0 )) || return 0
  (( _shellsense_sel < _shellsense_top )) && _shellsense_top=$_shellsense_sel
  (( _shellsense_sel >= _shellsense_top + rows )) && _shellsense_top=$(( _shellsense_sel - rows + 1 ))

  # A row is: left edge, icon, name, description, right edge. With an outline the edges are the
  # border plus a space inside it; without one they are a single cell each.
  local -i outline=1
  [[ $SHELLSENSE_BOX == flat ]] && outline=0
  local -i lead=$(( outline + 1 + ($#_shellsense_glyph ? 2 : 0) ))
  # Fit the two columns into the terminal: shrink the description first, then the name.
  local -i namew=$(( _shellsense_namew > 34 ? 34 : _shellsense_namew ))
  local -i descw=$(( _shellsense_descw > 52 ? 52 : _shellsense_descw ))
  local -i maxw=$(( COLUMNS - 1 )) total
  total=$(( lead + namew + (descw > 0 ? descw + 3 : 0) + 2 ))
  if (( total > maxw && descw > 0 )); then
    descw=$(( descw - (total - maxw) ))
    (( descw < 10 )) && descw=0
    total=$(( lead + namew + (descw > 0 ? descw + 3 : 0) + 2 ))
  fi
  if (( total > maxw )); then
    namew=$(( maxw - lead - 2 ))
    (( namew < 1 )) && return 0
    total=$maxw
  fi

  # Line the names up under the word being completed.
  local -i col=0
  if (( _shellsense_basecol >= 0 )); then
    local before=${BUFFER[1,_shellsense_rstart]}
    if [[ $before == *$'\n'* ]]; then
      col=${(m)#${before##*$'\n'}}
    else
      col=$(( (_shellsense_basecol + ${(m)#before}) % COLUMNS ))
    fi
    col=$(( col - lead ))
  fi
  (( col + total > maxw )) && col=$(( maxw - total ))
  (( col < 0 )) && col=0

  # The right edge doubles as a scrollbar when there are more rows than fit.
  local -i thumb=0 thumbat=0
  if (( n > rows )); then
    thumb=$(( rows * rows / n ))
    (( thumb < 1 )) && thumb=1
    thumbat=$(( (_shellsense_top - 1) * (rows - thumb) / (n - rows) ))
  fi

  # Another plugin (zsh-autosuggestions) may own the start of POSTDISPLAY; the popup goes after it.
  local other=$POSTDISPLAY
  [[ -n $_shellsense_post && $other == *"$_shellsense_post" ]] && other=${other%"$_shellsense_post"}
  region_highlight=( ${region_highlight:#*memo=shellsense*} )

  # Backgrounds: `fill` behind ordinary rows, `edge` behind the outline. Empty means the
  # terminal's own background shows through, which is what the rounded box wants.
  local fill= edge= line=$_shellsense_c_border accent=$SHELLSENSE_ACCENT dim=$_shellsense_c_dim
  [[ $SHELLSENSE_BOX == rounded ]] || fill=$_shellsense_c_panel edge=$_shellsense_c_panel
  local pad=${(l:col:):-} post= name padded desc kind bg bold
  local -i base=$(( $#BUFFER + $#other )) i r=0 ms ml inthumb

  if (( outline )); then
    post+=$'\n'$pad
    _shellsense_put "╭${(l:total-2::─:):-}╮" "$line" "$edge"
  elif (( SHELLSENSE_PADDING )); then
    post+=$'\n'$pad
    _shellsense_put "${(l:total::▄:):-}" "$_shellsense_c_panel"
  fi

  for (( i = _shellsense_top; i < _shellsense_top + rows; i++, r++ )); do
    post+=$'\n'$pad
    bg=$fill bold=
    (( i == _shellsense_sel )) && bg=$_shellsense_c_sel bold=1
    inthumb=$(( thumb > 0 && r >= thumbat && r < thumbat + thumb ))

    # Left edge. The selected row is marked on the edge itself: a heavier stroke in the accent colour.
    if (( outline )); then
      if (( i == _shellsense_sel )); then _shellsense_put "┃" "$accent" "$edge"; else _shellsense_put "│" "$line" "$edge"; fi
      _shellsense_put " " "" "$bg"
    elif (( i == _shellsense_sel )); then
      _shellsense_put "▎" "$accent" "$bg"
    else
      _shellsense_put " " "" "$bg"
    fi

    if (( $#_shellsense_glyph )); then
      kind=$_shellsense_kind[i]
      _shellsense_put "${_shellsense_glyph[$kind]:-$_shellsense_glyph[a]} " "${_shellsense_tint[$kind]:-$_shellsense_tint[a]}" "$bg"
    fi

    # The name, with the characters the user typed picked out in the accent colour.
    name=$_shellsense_display[i]
    (( ${(m)#name} > namew )) && name="${(mr:namew-1:)name}…"
    ms=$_shellsense_mstart[i] ml=$_shellsense_mlen[i]
    (( ms + ml > $#name )) && ml=$(( $#name - ms ))
    padded=${(mr:namew:)name}
    if (( ml > 0 )); then
      _shellsense_put "${padded[1,ms]}" "" "$bg" "$bold"
      _shellsense_put "${padded[ms+1,ms+ml]}" "$accent" "$bg" 1
      _shellsense_put "${padded[ms+ml+1,-1]}" "" "$bg" "$bold"
    else
      _shellsense_put "$padded" "" "$bg" "$bold"
    fi

    if (( descw > 0 )); then
      desc=$_shellsense_desc[i]
      (( ${(m)#desc} > descw )) && desc="${(mr:descw-1:)desc}…"
      _shellsense_put "   ${(mr:descw:)desc} " "$dim" "$bg"
    else
      _shellsense_put " " "" "$bg"
    fi

    # Right edge, which is also the scrollbar.
    if (( outline )); then
      if (( inthumb )); then _shellsense_put "┃" "$dim" "$edge"; else _shellsense_put "│" "$line" "$edge"; fi
    elif (( inthumb )); then
      _shellsense_put " " "" "$_shellsense_c_thumb"
    else
      _shellsense_put " " "" "$bg"
    fi
  done

  if (( outline )); then
    # The bottom edge carries two small labels: the position in a long list, and what Enter does.
    local left= right=
    if (( SHELLSENSE_HINTS )); then
      (( n > rows )) && left=" $_shellsense_sel/$n "
      if _shellsense_enter_inserts; then right=" ↵ insert "; else right=" ⇥ insert · ↵ run "; fi
      (( $#left + $#right + 4 > total )) && right=
      (( $#left + 4 > total )) && left=
    fi
    local -i rule=$(( total - 2 - $#left - $#right - (${#left} ? 1 : 0) - (${#right} ? 1 : 0) ))
    post+=$'\n'$pad
    _shellsense_put "╰${left:+─}" "$line" "$edge"
    _shellsense_put "$left" "$dim" "$edge"
    _shellsense_put "${(l:rule::─:):-}" "$line" "$edge"
    _shellsense_put "$right" "$dim" "$edge"
    _shellsense_put "${right:+─}╯" "$line" "$edge"
  elif (( SHELLSENSE_PADDING )); then
    post+=$'\n'$pad
    _shellsense_put "${(l:total::▀:):-}" "$_shellsense_c_panel"
  fi
  _shellsense_post=$post
  POSTDISPLAY=$other$post
}

# Appends text to the popup being built and colours it: text, foreground, background, bold.
# It works on `post` and `base`, the variables of _shellsense_render, which a zsh function can see
# in its caller.
_shellsense_put() {
  [[ -n $1 ]] || return 0
  local -i from=$(( base + $#post ))
  local spec=${2:+fg=$2}
  [[ -n $3 ]] && spec+=${spec:+,}bg=$3
  [[ -n $4 ]] && spec+=${spec:+,}bold
  post+=$1
  region_highlight+=("$from $(( base + $#post )) ${spec:-none} memo=shellsense")
}

# ---- look ----------------------------------------------------------------------------------

# Sets REPLY to the colour that is $7 percent of the way from r g b ($1-$3) to r g b ($4-$6).
_shellsense_mix() {
  printf -v REPLY '#%02x%02x%02x' \
    $(( $1 + ($4 - $1) * $7 / 100 )) $(( $2 + ($5 - $2) * $7 / 100 )) $(( $3 + ($6 - $3) * $7 / 100 ))
}

# Picks icons and the four shades of the popup. The panel and selection are the terminal's own
# background nudged towards its foreground, so the popup belongs to whatever theme is in use;
# icon colours are palette entries 1-6, which follow the theme by definition.
_shellsense_look() {
  emulate -L zsh
  local icons=$SHELLSENSE_ICONS REPLY
  [[ $icons == auto ]] && { [[ ${POWERLEVEL9K_MODE-} == nerdfont* ]] && icons=nerd || icons=dots }
  _shellsense_glyph=()
  case $icons in
    (nerd) _shellsense_glyph=( s $'\uf120' o $'\uf024' a $'\uf02b' f $'\uf15b' d $'\uf07b' b $'\uf126' p $'\uf1b2' ) ;;
    (dots) _shellsense_glyph=( s ● o ● a ● f ● d ● b ● p ● ) ;;
  esac

  local -i dark=1
  local -a b f
  b=( ${=_shellsense_bg_rgb} ) f=( ${=_shellsense_fg_rgb} )
  if [[ $SHELLSENSE_THEME == light ]]; then
    dark=0
  elif [[ $SHELLSENSE_THEME == auto ]] && (( $#b == 3 )); then
    (( (b[1] * 299 + b[2] * 587 + b[3] * 114) / 1000 >= 128 )) && dark=0
  fi
  if [[ $SHELLSENSE_THEME == auto && ${COLORTERM-} == (truecolor|24bit) ]] && (( $#b == 3 )); then
    (( $#f == 3 )) || { (( dark )) && f=(220 220 220) || f=(40 40 40) }
    local -a accent
    accent=( ${=_shellsense_accent_rgb} )
    _shellsense_mix $b $f 8;  _shellsense_c_panel=$REPLY
    _shellsense_mix $b $f 30; _shellsense_c_thumb=$REPLY
    _shellsense_mix $b $f 30; _shellsense_c_border=$REPLY
    _shellsense_mix $f $b 42; _shellsense_c_dim=$REPLY
    # The selected row is tinted with the accent colour when the terminal told us what that is.
    if (( $#accent == 3 )); then _shellsense_mix $b $accent 26; else _shellsense_mix $b $f 18; fi
    _shellsense_c_sel=$REPLY
  elif (( dark )); then
    _shellsense_c_panel=236 _shellsense_c_sel=239 _shellsense_c_thumb=243 _shellsense_c_dim=246 _shellsense_c_border=241
  else
    _shellsense_c_panel=254 _shellsense_c_sel=251 _shellsense_c_thumb=246 _shellsense_c_dim=243 _shellsense_c_border=248
  fi
  _shellsense_c_border=${SHELLSENSE_COLOR_BORDER:-$_shellsense_c_border}
  _shellsense_c_panel=${SHELLSENSE_COLOR_PANEL:-$_shellsense_c_panel}
  _shellsense_c_sel=${SHELLSENSE_COLOR_SELECTED:-$_shellsense_c_sel}
  _shellsense_c_thumb=${SHELLSENSE_COLOR_THUMB:-$_shellsense_c_thumb}
  _shellsense_c_dim=${SHELLSENSE_COLOR_DIM:-$_shellsense_c_dim}
  _shellsense_tint=( s 5 o 3 a 6 f $_shellsense_c_dim d 4 b 2 p 1 )
}

# Asks the terminal for its foreground, background and accent colours, once per shell.
_shellsense_ask_colors() {
  emulate -L zsh
  _shellsense_asked_colors=1
  [[ $SHELLSENSE_THEME == auto && ${COLORTERM-} == (truecolor|24bit) && -z $SHELLSENSE_NO_COLOR_QUERY ]] || return 0
  local ask=$'\e]10;?\e\\\e]11;?\e\\'
  if [[ $SHELLSENSE_ACCENT == '#'[0-9a-fA-F](#c6) ]]; then
    _shellsense_accent_rgb="$(( 16#${SHELLSENSE_ACCENT[2,3]} )) $(( 16#${SHELLSENSE_ACCENT[4,5]} )) $(( 16#${SHELLSENSE_ACCENT[6,7]} ))"
  elif [[ $SHELLSENSE_ACCENT == <0-255> ]]; then
    ask+=$'\e]4;'$SHELLSENSE_ACCENT$';?\e\\'
  fi
  print -n -- $ask >/dev/tty
}

# Bound to ESC ] 1 and ESC ] 4, the start of the replies ("ESC ] 10 ; rgb:…", "ESC ] 11 ; rgb:…"
# and "ESC ] 4 ; n ; rgb:…"). It reads exactly the replies and hands anything else back, since
# the cursor report or the user's own typing may be right behind them.
shellsense-color-report() {
  emulate -L zsh
  setopt extendedglob
  local ch body=${KEYS[-1]}
  local -i guard=0
  local -a match mbegin mend
  while (( guard++ < 200 )); do
    read -t 0.1 -k 1 ch || break
    if [[ $ch == $'\a' || ( $ch == '\' && $body == *$'\e' ) ]]; then
      # End of one reply. Colours come as rgb:RRRR/GGGG/BBBB; two hex digits per channel are enough.
      if [[ ${body%$'\e'} == (#b)(10|11|4';'<->)';rgb:'([0-9a-fA-F](#c2))[0-9a-fA-F]#/([0-9a-fA-F](#c2))[0-9a-fA-F]#/([0-9a-fA-F](#c2))* ]]; then
        local rgb="$(( 16#$match[2] )) $(( 16#$match[3] )) $(( 16#$match[4] ))"
        case $match[1] in
          (10) _shellsense_fg_rgb=$rgb ;;
          (11) _shellsense_bg_rgb=$rgb ;;
          (*)  _shellsense_accent_rgb=$rgb ;;
        esac
      fi
      # Is another reply following? Anything else goes back where it came from.
      read -t 0.05 -k 1 ch || break
      if [[ $ch != $'\e' ]]; then zle -U -- "$ch"; break; fi
      read -t 0.05 -k 1 ch || { zle -U -- $'\e'; break }
      if [[ $ch != ']' ]]; then zle -U -- $'\e'"$ch"; break; fi
      body=
      continue
    fi
    body+=$ch
  done
  _shellsense_look
  (( _shellsense_visible )) && _shellsense_render
  return 0
}

_shellsense_unrender() {
  [[ -n $_shellsense_post ]] || return 0
  [[ $POSTDISPLAY == *"$_shellsense_post" ]] && POSTDISPLAY=${POSTDISPLAY%"$_shellsense_post"}
  region_highlight=( ${region_highlight:#*memo=shellsense*} )
  _shellsense_post=
}

_shellsense_hide() {
  _shellsense_visible=0 _shellsense_nav=0
  _shellsense_unbind
  _shellsense_unrender
}

# ---- cursor column -------------------------------------------------------------------------

# Asks the terminal where the cursor is. The device-attributes query goes first because its reply
# starts with ESC [ ?, a prefix no key sends, which lets a key binding catch the pair of replies.
_shellsense_ask() {
  [[ -n $SHELLSENSE_NO_CURSOR_QUERY ]] && return 0
  _shellsense_asked=1
  _shellsense_askw=${(m)#${LBUFFER##*$'\n'}}
  print -n -- $'\e[c\e[6n' >/dev/tty
}

shellsense-cursor-report() {
  emulate -L zsh
  setopt extendedglob
  local ch buf=
  local -i tries=0
  local -a match mbegin mend
  while (( tries++ < 48 )) && read -t 0.1 -k 1 ch; do
    buf+=$ch
    [[ $buf == *c$'\e['<->';'<->R ]] && break
  done
  if [[ $buf == (#b)*c$'\e['<->';'(<->)R ]]; then
    _shellsense_basecol=$(( (match[1] - 1 - _shellsense_askw) % COLUMNS ))
    (( _shellsense_basecol < 0 )) && _shellsense_basecol=$(( _shellsense_basecol + COLUMNS ))
    (( _shellsense_visible )) && _shellsense_render
  elif [[ $buf == *c* ]]; then
    # Only the first reply came; whatever followed it was typed by the user.
    zle -U -- "${buf#*c}"
  fi
  return 0
}

# ---- keys ----------------------------------------------------------------------------------

_shellsense_bind() {
  (( _shellsense_bound )) && return 0
  local key out
  if (( ! $#_shellsense_orig )); then
    for key in ${(k)_shellsense_keys}; do
      out=$(bindkey -M main -- $key 2>/dev/null) || continue
      out=${out##* }
      # Leave vi users their Esc, and never record our own widgets as "the original".
      [[ $out == shellsense-* || $out == \"* || ( $key == $'\e' && $out == vi-cmd-mode ) ]] && continue
      _shellsense_orig[$key]=$out
    done
  fi
  for key in ${(k)_shellsense_orig}; do
    bindkey -M main -- $key $_shellsense_keys[$key]
  done
  # A bare Esc is ambiguous with the start of an arrow key; shorten the wait while the popup is up.
  if (( ${KEYTIMEOUT:-40} == 40 )); then
    _shellsense_keytimeout=1
    KEYTIMEOUT=5
  fi
  _shellsense_bound=1
}

_shellsense_unbind() {
  (( _shellsense_bound )) || return 0
  local key
  for key in ${(k)_shellsense_orig}; do
    if [[ $_shellsense_orig[$key] == undefined-key ]]; then
      bindkey -M main -r -- $key
    else
      bindkey -M main -- $key $_shellsense_orig[$key]
    fi
  done
  if (( _shellsense_keytimeout )); then
    KEYTIMEOUT=40
    _shellsense_keytimeout=0
  fi
  _shellsense_bound=0
}

# Closes the popup and replays the key, so the widget it is normally bound to runs as if shellsense
# had never been in the way (history search and friends depend on being invoked directly).
_shellsense_passthrough() {
  local -i bound=$_shellsense_bound
  _shellsense_cancel
  # If the key was not ours to give back, replaying it would call this widget again, forever.
  (( bound )) && zle -U -- "$KEYS"
}

_shellsense_apply() {
  local insert=$_shellsense_insert[_shellsense_sel]
  local -i back=$_shellsense_back[_shellsense_sel]
  (( _shellsense_rstart <= CURSOR )) || return 1
  LBUFFER="${LBUFFER[1,_shellsense_rstart]}${insert}"
  if (( back > 0 )); then
    RBUFFER="${LBUFFER[-back,-1]}${RBUFFER}"
    LBUFFER=${LBUFFER[1,-back-1]}
  fi
  _shellsense_nav=0
}

shellsense-accept() {
  if _shellsense_await; then _shellsense_apply; else _shellsense_passthrough; fi
}

# Decides what Enter means while the popup is open: insert the highlighted row, or run the line.
# It inserts the highlighted row, which is the top one until the arrows are used. It runs the
# line when that would change nothing: the word is already one of the rows in full (`cd src`
# next to a `src/` row), or the highlighted row is the "." that stands for a folder already typed.
_shellsense_enter_inserts() {
  # A row that would insert exactly what is there already (the "." row inside a folder) changes
  # nothing, so Enter on it means "run".
  [[ $_shellsense_insert[_shellsense_sel] == "${LBUFFER[_shellsense_rstart+1,-1]}" ]] && return 1
  (( _shellsense_nav )) && return 0
  [[ $SHELLSENSE_ENTER == run ]] && return 1
  # The engine says whether the line already makes sense as typed.
  (( ! _shellsense_complete ))
}

shellsense-enter() {
  if (( _shellsense_visible )) && _shellsense_await && _shellsense_enter_inserts; then
    _shellsense_apply
  else
    _shellsense_passthrough
  fi
}

shellsense-down() {
  (( _shellsense_visible )) || { _shellsense_passthrough; return 0 }
  local -i n=$#_shellsense_insert
  if (( _shellsense_nav )); then
    _shellsense_sel=$(( _shellsense_sel % n + 1 ))
  else
    _shellsense_nav=1
    (( n > 1 )) && _shellsense_sel=2
  fi
  _shellsense_render
}

# Until the user has moved into the popup, Up still means "previous history entry".
shellsense-up() {
  (( _shellsense_visible && _shellsense_nav )) || { _shellsense_passthrough; return 0 }
  local -i n=$#_shellsense_insert
  _shellsense_sel=$(( (_shellsense_sel + n - 2) % n + 1 ))
  _shellsense_render
}

# Esc closes the popup for the word being typed; it comes back with the next word.
shellsense-dismiss() {
  _shellsense_dismissed=$_shellsense_rstart
  _shellsense_cancel
}

# ---- Ctrl-C --------------------------------------------------------------------------------

# zsh does not run line-finish when a line is interrupted, so without this the popup would stay
# on screen above the next prompt. An INT trap is the one place that still runs inside the editor.
_shellsense_abort() {
  _shellsense_cancel
  zle -R
}

_shellsense_on_interrupt() {
  (( _shellsense_visible )) && zle && zle _shellsense_abort 2>/dev/null
  return 0
}

# Puts our handler in front of whatever INT trap is already there, and keeps calling that one.
# Checked at every prompt because prompts and plugins replace the trap.
_shellsense_trap_interrupt() {
  # powerlevel10k re-installs its trap from this variable each time one of its functions returns,
  # so the variable is the only place a handler survives.
  if (( ${+__p9k_trapint} )); then
    if [[ $__p9k_trapint != *_shellsense_on_interrupt* ]]; then
      __p9k_trapint="_shellsense_on_interrupt; $__p9k_trapint"
      trap "$__p9k_trapint" INT
    fi
    return 0
  fi
  [[ ${functions[TRAPINT]-} == *_shellsense_on_interrupt* ]] && return 0
  if (( ${+functions[TRAPINT]} )); then
    functions[_shellsense_previous_trapint]=$functions[TRAPINT]
    TRAPINT() { _shellsense_on_interrupt; _shellsense_previous_trapint "$@" }
    return 0
  fi
  # A trap set with `trap '…' INT` is only visible in the output of `trap`, and a subshell
  # (which $(trap) would be) has no traps to show, so it goes through a file.
  local file=${TMPPREFIX:-/tmp/zsh}shellsense$$ text=
  { trap >| $file } 2>/dev/null && text=$(<$file)
  zf_rm -f -- $file 2>/dev/null
  local -a words
  words=( ${(z)text} )
  local -i at=${words[(Ie)INT]}
  if (( at > 3 )) && [[ $words[at-3] == trap ]]; then
    typeset -g _shellsense_previous_trap=${(Q)words[at-1]}
    TRAPINT() { _shellsense_on_interrupt; eval "$_shellsense_previous_trap" }
  else
    # No trap before ours: returning 128+signal keeps the default behaviour of abandoning the line.
    TRAPINT() { _shellsense_on_interrupt; return $(( 128 + $1 )) }
  fi
}

# ---- line editor hooks ---------------------------------------------------------------------

_shellsense_line_init() {
  _shellsense_last= _shellsense_post=
  _shellsense_dismissed=-1 _shellsense_basecol=-1 _shellsense_asked=0
  _shellsense_hide
  _shellsense_trap_interrupt
  [[ -n $_shellsense_c_panel ]] || _shellsense_look
  _shellsense_connect || return 0
  (( ${#aliases} == _shellsense_naliases )) || _shellsense_hello
  # A command has run since the last line: branches, files and containers may have changed.
  _shellsense_send L
  # With typeahead pending, a reply could arrive after the typed command has already started.
  if (( ! PENDING )); then
    (( _shellsense_asked_colors )) || _shellsense_ask_colors
    _shellsense_ask
  fi
  return 0
}

_shellsense_pre_redraw() {
  local state="$CURSOR$_shellsense_us$BUFFER"
  if [[ $state == "$_shellsense_last" ]]; then
    # Same text as before: only repair the popup if another plugin rewrote POSTDISPLAY.
    (( _shellsense_visible )) && [[ $POSTDISPLAY != *"$_shellsense_post" ]] && _shellsense_render
    return 0
  fi
  _shellsense_last=$state
  # A dismissal is for one word; it ends once the cursor is back in front of that word.
  (( CURSOR < _shellsense_dismissed )) && _shellsense_dismissed=-1
  if [[ -z $BUFFER || $KEYMAP == vicmd ]]; then
    _shellsense_cancel
    return 0
  fi
  # Only typing opens the popup. Recalling history or moving the cursor must not, or the popup
  # would capture the very next arrow key.
  case $LASTWIDGET in
    (self-insert|magic-space|backward-delete-char|vi-backward-delete-char|delete-char|backward-kill-word|vi-backward-kill-word|kill-word|shellsense-accept|shellsense-enter) ;;
    (*) _shellsense_cancel; return 0 ;;
  esac
  _shellsense_query
  # Until the answer arrives the old rows stay up, redrawn because their offsets moved with the buffer.
  (( _shellsense_visible )) && _shellsense_render
  return 0
}

_shellsense_line_finish() {
  _shellsense_cancel
  return 0
}

zle -N _shellsense_recv
zle -N _shellsense_line_init
zle -N _shellsense_pre_redraw
zle -N _shellsense_line_finish
zle -N _shellsense_abort
zle -N shellsense-accept
zle -N shellsense-enter
zle -N shellsense-up
zle -N shellsense-down
zle -N shellsense-dismiss
zle -N shellsense-cursor-report
zle -N shellsense-color-report
add-zle-hook-widget line-init _shellsense_line_init
add-zle-hook-widget line-pre-redraw _shellsense_pre_redraw
add-zle-hook-widget line-finish _shellsense_line_finish
bindkey -M main $'\e[?' shellsense-cursor-report
bindkey -M main $'\e]1' shellsense-color-report
bindkey -M main $'\e]4' shellsense-color-report
