# Entry point for zsh plugin managers (oh-my-zsh, zinit, antidote, …), which clone this repository
# and source this file. The engine's dependencies still have to be installed once.
if [[ ! -d ${0:A:h}/node_modules ]]; then
  print -u2 "shellsense: one more step — run: npm install --omit=dev --prefix ${(q)0:A:h}"
  return 0
fi
source ${0:A:h}/shell/shellsense.zsh
