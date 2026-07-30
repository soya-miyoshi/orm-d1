# History — persisted in the commandhistory volume, so it survives rebuilds.
export HISTFILE=/commandhistory/.zsh_history

# Prompt
PROMPT="%F{green}%n%f:%F{blue}%~%f %# "

# Aliases
alias cds="claude --dangerously-skip-permissions"

# The three commands this repo actually runs.
alias tu="npm run test:unit"       # Node, milliseconds
alias tw="npm run test:workers"    # workerd + real D1
alias ck="npm run check"           # the full gate, before handing work back
