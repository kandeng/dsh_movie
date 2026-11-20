#!/usr/bin/env bash
# DSH Movie stack startup (idempotent — anything already running is left alone):
#   1. systemd user services: dsh-postgre (5432) then dsh-synapse (8008)
#   2. DSH server: identity listener 8787 + movie gateway 8788 (pnpm start:web)
#   3. web client: vite dev server 5173 (pnpm dev:web)
# The two app processes are daemonized (setsid + nohup); their output lands in
# logs/gateway.log and logs/vite.log. Companion: stop.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
FAIL=0

port_up() { ss -ltn 2>/dev/null | grep -q ":$1 "; }

wait_port() { # $1 port, $2 label, $3 timeout seconds
  local _
  for _ in $(seq 1 "$3"); do
    if port_up "$1"; then echo "  ok   $2 listening on :$1"; return 0; fi
    sleep 1
  done
  echo "  FAIL $2 did not open :$1 within ${3}s — check $LOG_DIR"; FAIL=1; return 1
}

echo "── 1/3 systemd user services (postgres → synapse)"
if ! systemctl --user start dsh-postgre.service; then echo "  FAIL dsh-postgre did not start"; FAIL=1; fi
if ! systemctl --user start dsh-synapse.service; then echo "  FAIL dsh-synapse did not start"; FAIL=1; fi
wait_port 5432 postgres 15
wait_port 8008 synapse 30

echo "── 2/3 DSH server (identity :8787 + gateway :8788)"
if port_up 8788; then
  echo "  skip gateway already running on :8788"
else
  cd "$ROOT" || exit 1
  setsid nohup pnpm start:web >"$LOG_DIR/gateway.log" 2>&1 </dev/null &
  disown
  wait_port 8788 gateway 60
fi

echo "── 3/3 web client (vite :5173)"
if port_up 5173; then
  echo "  skip vite already running on :5173"
else
  cd "$ROOT" || exit 1
  setsid nohup pnpm dev:web >"$LOG_DIR/vite.log" 2>&1 </dev/null &
  disown
  wait_port 5173 vite 60
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "DSH Movie up → http://127.0.0.1:5173 (logs: $LOG_DIR)"
else
  echo "DSH Movie started with failures — inspect $LOG_DIR and re-run ./start.sh"
fi
exit "$FAIL"
