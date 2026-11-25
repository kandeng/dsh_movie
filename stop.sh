#!/usr/bin/env bash
# DSH Movie stack shutdown (idempotent):
#   1. web client (vite :5173) and DSH server (:8787/:8788) process trees
#   2. systemd user services: dsh-synapse then dsh-postgre, followed by a port
#      sweep of :8008/:5432 that catches instances started BY HAND — those live
#      outside the unit's cgroup, so systemctl alone cannot stop them
# NOTE: the local ComfyUI engine (:8188) is deliberately NOT stopped here — its
# lifecycle is owned by server/comfy_stop.sh (and the Supply page Disconnect
# button). Stop it explicitly with: ./server/comfy_stop.sh
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

# Fallback port sweep. A homeserver/postgres launched from a terminal is
# reparented to `systemd --user` but stays in the launching terminal's scope
# (e.g. app-gnome-qoder-*.scope), NOT in dsh-synapse.service — so the stops above
# are a silent no-op against it and :8008 keeps listening. Killing by port catches
# it whichever cgroup it is in. Order mirrors the services: homeserver first, then
# the database it depends on (SIGTERM is a clean fast shutdown for postgres).
stop_port 8008 "synapse (by port)"
stop_port 5432 "postgres (by port)"

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
