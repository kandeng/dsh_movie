#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# H20 ComfyUI scale-out: 3 extra workers on GPUs 1-3, ports 8189-8191.
#
# The main engine (GPU0, port 8188) is launched by /root/comfy/start.sh and is
# left untouched. This script adds three MORE ComfyUI processes that SHARE the
# same install (models/, custom_nodes/) but pin one GPU each and write to their
# own output/ + log files, so the DSH-Movie gateway can pool all four endpoints
# (round-robin + submit failover, DSH_COMFY_INFLIGHT_MAX=1 per endpoint).
#
# Layout (verified read-only from comfy_INSTALL.md):
#   ComfyUI root : /root/comfy/ComfyUI
#   venv python  : /root/comfy/venv/bin/python
#   logs         : /root/comfy/log/
#   GPUs         : 8 visible (device_count()==8); workers take 1,2,3
#
# Idempotent: a worker whose port already answers /system_stats is skipped.
# Run:  bash /root/comfy/start_workers.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

COMFY_ROOT="${COMFY_ROOT:-/root/comfy/ComfyUI}"
PY="${COMFY_PY:-/root/comfy/venv/bin/python}"
LOG_DIR="${COMFY_LOG_DIR:-/root/comfy/log}"
LISTEN_HOST="${COMFY_LISTEN:-0.0.0.0}"
READY_TIMEOUT="${COMFY_READY_TIMEOUT:-120}"

# GPU -> port map for the three extra workers (GPU0/8188 stays the main engine).
GPUS=(1 2 3)
PORTS=(8189 8190 8191)

mkdir -p "$LOG_DIR"

port_up() {  # $1 = port
  curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$1/system_stats"
}

wait_port() {  # $1 = port, $2 = label
  local deadline=$((SECONDS + READY_TIMEOUT))
  while (( SECONDS < deadline )); do
    if port_up "$1"; then echo "  ok   $2 listening on :$1"; return 0; fi
    sleep 2
  done
  echo "  FAIL $2 did not answer on :$1 within ${READY_TIMEOUT}s (see $LOG_DIR/worker-$1.log)"
  return 1
}

echo "── H20 ComfyUI scale-out (workers on GPUs ${GPUS[*]} → ports ${PORTS[*]})"
cd "$COMFY_ROOT" || { echo "ComfyUI root not found: $COMFY_ROOT"; exit 1; }

pids=()
for i in "${!GPUS[@]}"; do
  gpu="${GPUS[$i]}"; port="${PORTS[$i]}"
  if port_up "$port"; then
    echo "  skip :$port already answering (GPU $gpu worker already up)"
    continue
  fi
  # CUDA_VISIBLE_DEVICES pins the physical GPU; inside the process it is index 0.
  # --disable-auto-launch: no browser. Separate --output-directory per worker so
  # SaveImage/SaveVideo filenames never collide across the pooled endpoints.
  CUDA_VISIBLE_DEVICES="$gpu" \
    setsid nohup "$PY" main.py \
      --listen "$LISTEN_HOST" \
      --port "$port" \
      --cuda-device 0 \
      --disable-auto-launch \
      --output-directory "$COMFY_ROOT/output-$port" \
      >"$LOG_DIR/worker-$port.log" 2>&1 </dev/null &
  pids+=("$!")
  echo "  launched GPU $gpu worker on :$port (pid $!, log $LOG_DIR/worker-$port.log)"
done

echo "── waiting for workers to answer /system_stats"
rc=0
for i in "${!PORTS[@]}"; do
  port="${PORTS[$i]}"
  port_up "$port" || wait_port "$port" "GPU ${GPUS[$i]} worker" || rc=1
done

echo "── self-verify (all four endpoints)"
for port in 8188 "${PORTS[@]}"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$port/system_stats")"
  echo "  :$port /system_stats -> $code"
done

if (( rc == 0 )); then
  echo "DONE: 4 endpoints ready (8188 main + ${PORTS[*]} workers)."
  echo "Next (local DSH-Movie host): set DSH_COMFY_POOL=http://10.188.8.105:8189,http://10.188.8.105:8190,http://10.188.8.105:8191 in server/comfy.env and restart the gateway."
else
  echo "DONE with errors: inspect $LOG_DIR/worker-*.log for the failed worker(s)."
fi
exit "$rc"
