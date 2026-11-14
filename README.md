# shellsense

IDE-style autocomplete for your terminal.

[![npm](https://img.shields.io/npm/v/shellsense)](https://www.npmjs.com/package/shellsense)
[![license](https://img.shields.io/npm/l/shellsense)](LICENSE)

Type a command and a list of what can come next opens under the word you are typing:
subcommands, options, git branches, npm scripts, files and folders, each with a short
description. Pick one with the arrow keys or keep typing to narrow the list.

```
❯ git commit -
      -m, --message       Use the given message as the commit message
      -a, --all                  Stage all modified and deleted paths
    ❨ -v, --verbose             Show unified diff of all file changes ❩
      -p, --patch       Use the interactive patch selection interface…
      option   3/41                             ↵ insert   esc close
```

The popup is a filled card with a soft shadow, so it reads as floating above the terminal; the
highlighted row is a solid bar in your terminal's bright blue.

## Features

- **Knows about 700 command-line tools**: `git`, `docker`, `npm`, `kubectl`, `aws`, `cargo`,
  `brew` and many more, including their subcommands, options and argument values.
- **Live values**: git branches, npm scripts, files and folders are looked up as you type.
- **Understands your aliases**: `gco` completes as `git checkout` if that is what it stands for.
- **Learns what you use**: subcommands, options, branches and folders you used recently are
  offered first.
- **Drawn inside the terminal**: no extra window, no accessibility permission, nothing tied to
  one terminal emulator.
- **Matches your theme**: colours are derived from the terminal's own background, foreground
  and palette, in light and dark themes alike.
- **Stays out of the way**: its keys only apply while the popup is open, and typing never
  waits for suggestions.
- **Runs on your machine**: no account and no telemetry.

Status: early. zsh only for now, developed and tested on macOS.

## Install

```sh
npm install -g shellsense
shellsense setup
```

Open a new terminal and type `git ` followed by a letter.

`shellsense setup` adds one guarded line to `~/.zshrc`; `shellsense uninstall` takes it out
again. The engine starts by itself on the first prompt, stays in the background, and exits
after 30 minutes with no shells connected.

Requirements: zsh 5.9 or later, Node.js 20 or later, macOS or Linux. The completion specs make
the install about 140 MB.

### With a zsh plugin manager

The repository is also a plugin. Clone it where your manager expects plugins, then install the
engine's dependencies once. This route runs the TypeScript sources directly, so it needs
Node.js 23.6 or later.

```sh
# oh-my-zsh
git clone https://github.com/ThePubDoc/shellsense ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/shellsense
npm install --omit=dev --prefix ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/shellsense
# then add shellsense to plugins=(…) in ~/.zshrc
```

### From source

```sh
git clone https://github.com/ThePubDoc/shellsense && cd shellsense
npm install
bin/shellsense setup
```

## Keys

These keys belong to the popup only while it is open. When it closes they go back to whatever
they were bound to before.

| Key | With the popup open |
| --- | --- |
| `Tab` | Insert the highlighted row |
| `↓` | Move into the list, then down |
| `↑` | Move up; before you have moved into the list, recall history as usual |
| `Enter` | Insert the highlighted row (the top one until you use the arrows). Runs the line instead when the word is already complete |
| `Esc` | Close the popup for the word being typed |

The footer says what `Enter` will do: `↵ insert` or `↵ run`.

Inside a folder you have already typed (`cd src/`), the first row is `.` — the folder itself —
so `Enter` goes there and `↓` reaches the folders inside it.

When there is nothing to suggest, `Tab` is zsh's normal completion.

## Configuration

Set these in `~/.zshrc`, above the shellsense block.

### Behaviour

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHELLSENSE_MAX_ROWS` | `8` | Rows shown at once |
| `SHELLSENSE_ENTER` | `insert` | `run` makes Enter always run the line unless a row was picked with the arrows |
| `SHELLSENSE_HISTORY` | `1` | `0` stops this shell from recording what you run and from ranking by it |
| `SHELLSENSE_HINTS` | `1` | `0` removes the footer (what the highlighted row is, the position in the list, and what the keys do) |
| `SHELLSENSE_DETAIL` | `1` | Outlined styles only: `0` removes the section under the list that shows a long description in full |

### Appearance

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHELLSENSE_BOX` | `floating` | `floating` is a filled card with a shadow, `rounded` is an outlined box on the terminal's background, `card` is outlined and filled, `flat` is a plain filled panel |
| `SHELLSENSE_ICONS` | `auto` | `nerd`, `dots` or `none`. `auto` uses Nerd Font icons when powerlevel10k is set up for one, coloured dots otherwise |
| `SHELLSENSE_THEME` | `auto` | `dark` or `light` for fixed 256-colour shades. `auto` derives the shades from the terminal's own colours |
| `SHELLSENSE_ACCENT` | `12` | Colour of the highlighted row and of the characters you typed: a palette number (12 is your theme's bright blue) or `#rrggbb` |
| `SHELLSENSE_PADDING` | `1` | `flat` only: `0` removes the half-height padding above and below the list |
| `SHELLSENSE_COLOR_PANEL`, `_STRIP`, `_SHADOW`, `_SELECTED`, `_SELECTED_TEXT`, `_DIM`, `_THUMB`, `_BORDER` | unset | Override one shade: a palette number or `#rrggbb` |

Once per shell, shellsense asks the terminal for its background, foreground and accent colour.
The card, its footer strip and its shadow are shades of the terminal's own background, so the
popup belongs to whatever theme is in use, light or dark. The highlighted row is a solid bar of
the accent colour with white text (dark text if the accent is a light colour), with rounded
ends when a Nerd Font is in use. Icons use palette colours 1–6. Terminals that do not answer
get fixed 256-colour shades.

Descriptions sit against the right edge and are cut to fit. The right margin of the card is the
scrollbar, and the footer says what the highlighted row is, where you are in a long list, and
what `Enter` will do.

### Advanced

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHELLSENSE_NODE` | `node` | Node binary that runs the engine |
| `SHELLSENSE_SOCK` | `~/.local/state/shellsense/sock` | Engine socket (at most ~100 bytes long) |
| `SHELLSENSE_NO_AUTOSTART` | unset | Set to stop shells from starting the engine |
| `SHELLSENSE_NO_CURSOR_QUERY` | unset | Set to stop asking the terminal for the cursor column; the popup is then left-aligned |
| `SHELLSENSE_NO_COLOR_QUERY` | unset | Set to stop asking the terminal for its colours; the fixed shades are used |

## Commands

```
shellsense setup             turn the popup on (adds one line to ~/.zshrc)
shellsense uninstall         turn it off (removes the line, stops the engine)
shellsense status            is the engine running?
shellsense stop              stop it (the next prompt starts a fresh one)
shellsense suggest 'git ch'  print what the engine would suggest, without a shell
shellsense forget            erase what shellsense remembers about what you used
shellsense init zsh          print the line that loads the popup, to place it yourself
```

After upgrading, run `shellsense stop` so shells pick up the new engine.

## History

Rows you have used before are offered first: `git ` puts the subcommands you actually run at
the top, `git checkout ` the branches you switch to, and `cd ` the folders you visit. Among
used rows, the ones used most recently and most often come first. What you type still decides
first; history only orders rows that match equally well. The footer marks such a row as
`recent`.

- **What is recorded.** Each word of a command you run, together with where in the command it
  was used, and each folder you change into. The first time the engine starts it also reads the
  latest 1,500 lines of your zsh history file, so ranking is useful from the start.
- **How it is stored.** As hashes with a count and a time, in
  `~/.local/state/shellsense/usage.json`. The words themselves are never written, so a token
  or password that appeared on a command line is not in that file.
- **Keeping a command out.** Start the line with a space, the usual zsh convention.
- **Turning it off.** `SHELLSENSE_HISTORY=0` in `~/.zshrc`. `shellsense forget` erases
  everything recorded so far.

## Troubleshooting

- **No popup at all.** Run `shellsense status`, then `shellsense suggest 'git ch'`. If the
  second prints rows, the engine is fine and the shell is not loading it: check that the
  shellsense block is in `~/.zshrc` and that you opened a new terminal. Engine errors are
  appended to `~/.local/state/shellsense/daemon.log`.
- **Two popups.** Another tool is drawing its own completion menu. Turn one of them off.
- **The popup sits at the left edge.** The terminal did not report the cursor position.
- **Plain grey instead of theme colours.** The terminal did not report its colours, or
  `COLORTERM` is not `truecolor`. Set the `SHELLSENSE_COLOR_*` variables to choose shades yourself.
- **Icons show as boxes.** Your font has no Nerd Font glyphs: set `SHELLSENSE_ICONS=dots`.

## How it works

- **Shell side** (`shell/shellsense.zsh`). A line-editor hook sends the buffer and cursor
  position to the engine after each edit and returns immediately. Replies arrive asynchronously
  and are shown through `POSTDISPLAY`, zsh's own mechanism for text after the buffer, so zsh
  does the scrolling and redrawing. There is no wrapper process around the shell.
- **Engine** (`src/`). One background process shared by all shells, reached over a Unix socket.
  It splits the line into words, walks them through the command's spec to find out what the
  word under the cursor can be, runs the spec's generators (`git branch`, `docker ps`, …) with
  a timeout, and ranks the result. Generator output is cached until the next prompt.
- **Protocol** (top of `src/daemon.ts`). One line per message, fields separated by control
  characters, so the shell can parse a reply without forking.

## Development

```sh
npm test            # tokenizer, suggestions, protocol
npm run test:e2e    # drives a real zsh inside tmux and checks the screen
npm run typecheck
npm pack            # builds dist/ and the tarball that `npm publish` would upload
```

A source checkout runs `src/*.ts` directly; the published package contains the compiled `dist/`.

## Roadmap

- bash and fish.
- Suggestions for the command name itself.
- An optional native floating window on macOS.
- A Homebrew formula, and a single binary so Node is not needed at run time.
- zsh older than 5.9.

## Acknowledgements

Completion specs come from the community-maintained
[withfig/autocomplete](https://github.com/withfig/autocomplete) collection.

## License

[MIT](LICENSE)
