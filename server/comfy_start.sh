#!/usr/bin/env bash
# Start the local ComfyUI engine (:8188) — idempotent:
#   • already listening  → report "already-running" and exit 0
#   • systemd unit alive → just wait for the port
#   • otherwise          → systemctl --user start comfyui-local.service
# If :8188 is held by a process OUTSIDE the unit (e.g. a manual terminal
# launch), that process is terminated first so the supervised unit can own
# the port. Companion: comfy_stop.sh. Used by the Supply page "Connect"
# button through the vite bridge (POST /local-comfy/ensure).
set -uo pipefail

UNIT="comfyui-local.service"
PORT=8188
TIMEOUT="${1:-120}"

port_up() { ss -ltn 2>/dev/null | grep -q ":$PORT "; }

if port_up; then
  if systemctl --user is-active --quiet "$UNIT"; then
    echo "already-running unit=$UNIT port=$PORT"
    exit 0
  fi
  # Port held by a foreign process: hand it over to the supervised unit.
  pids="$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -un)"
  echo "port $PORT held outside the unit (pid: ${pids:-?}) — stopping it first"
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill $pids 2>/dev/null
  for _ in $(seq 1 20); do port_up || break; sleep 0.5; done
  port_up && { echo "FAILED could not release port $PORT"; exit 1; }
fi

if ! systemctl --user is-active --quiet "$UNIT"; then
  systemctl --user start "$UNIT" || { echo "FAILED systemctl start $UNIT"; exit 1; }
fi

for _ in $(seq 1 "$TIMEOUT"); do
  if port_up; then
    echo "started unit=$UNIT port=$PORT"
    exit 0
  fi
  sleep 1
done

echo "FAILED $UNIT did not open :$PORT within ${TIMEOUT}s — journalctl --user -u $UNIT"
exit 1
