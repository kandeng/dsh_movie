#!/usr/bin/env bash
# Stop the local ComfyUI engine (:8188) — idempotent:
#   • unit inactive and port free → report "already-stopped" and exit 0
#   • otherwise → systemctl --user stop comfyui-local.service, then sweep any
#     leftover listener on :8188 (covers manual terminal launches).
# Companion: comfy_start.sh. Used by the Supply page "Disconnect" button
# through the vite bridge (POST /local-comfy/halt).
set -uo pipefail

UNIT="comfyui-local.service"
PORT=8188

port_up() { ss -ltn 2>/dev/null | grep -q ":$PORT "; }

if ! systemctl --user is-active --quiet "$UNIT" && ! port_up; then
  echo "already-stopped unit=$UNIT port=$PORT"
  exit 0
fi

systemctl --user stop "$UNIT" 2>/dev/null

# Sweep a foreign listener (process started outside the unit), if any.
if port_up; then
  pids="$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -un)"
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill $pids 2>/dev/null
  for _ in $(seq 1 20); do port_up || break; sleep 0.5; done
  if port_up; then
    pids="$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -un)"
    # shellcheck disable=SC2086
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
    sleep 0.5
  fi
fi

if port_up; then
  echo "FAILED :$PORT still listening after stop"
  exit 1
fi
echo "stopped unit=$UNIT port=$PORT"
exit 0
