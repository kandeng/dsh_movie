#!/usr/bin/env bash
# DSH Movie stack shutdown (idempotent):
#   1. web client (vite :5173) and DSH server (:8787/:8788) process trees
#   2. systemd user services: dsh-synapse then dsh-postgre
# Listeners are killed by port (works no matter which terminal started them);
# pnpm/sh wrappers are swept by command pattern afterwards. Companion: start.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

stop_port() { # $1 port, $2 label
  local pids _
  pids="$(ss -ltnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | sort -un)"
  if [ -z "$pids" ]; then
    echo "  skip $2 (:${1}) not running"
    return 0
  fi
  echo "  stop $2 (:${1}) pid $(echo $pids | tr '\n' ' ')"
  kill $pids 2>/dev/null
  for _ in $(seq 1 20); do
    ss -ltn 2>/dev/null | grep -q ":$1 " || return 0
    sleep 0.5
  done
  echo "  kill -9 $2 (:${1})"
  kill -9 $pids 2>/dev/null
  sleep 0.5
}

echo "── 1/2 app processes"
stop_port 5173 "vite dev server"
stop_port 8788 "DSH gateway"
stop_port 8787 "DSH identity listener"

# Stray wrappers left behind once their child died (pnpm/sh launchers).
pkill -f "dsh-movie-server start:web" 2>/dev/null
pkill -f "start:web" 2>/dev/null
pkill -f "$ROOT/client/web/node_modules/.bin/../vite/bin/vite.js" 2>/dev/null
pkill -f "pnpm dev:web" 2>/dev/null
sleep 1

echo "── 2/2 systemd user services (synapse → postgres)"
systemctl --user stop dsh-synapse.service
systemctl --user stop dsh-postgre.service

echo
LEFT=""
ss -ltn 2>/dev/null | grep -qE ':(5173|8787|8788|8008|5432) ' && LEFT="ports still listening:"
for p in 5173 8787 8788 8008 5432; do
  ss -ltn 2>/dev/null | grep -q ":$p " && LEFT="$LEFT $p"
done
if [ "$LEFT" = "" ]; then
  echo "DSH Movie fully stopped (app processes + synapse + postgres)."
else
  echo "WARNING — $LEFT"
  exit 1
fi
