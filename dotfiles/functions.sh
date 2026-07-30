# Sourced by both ~/.bashrc and ~/.zshrc (see Dockerfile).

# Kill whatever holds a port.
kp() {
  [ -z "$1" ] && echo "Usage: kp <port>" && return 1
  lsof -ti tcp:"$1" | xargs -r kill -9
}

# Kill workerd runtimes left behind by an interrupted vitest run. The workers
# test project starts them per run and shuts them down on exit; Ctrl-C at the
# wrong moment does not.
kw() {
  pkill -f workerd && echo "killed stray workerd" || echo "no workerd running"
}
