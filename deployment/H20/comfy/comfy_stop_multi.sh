#!/usr/bin/env bash
# Stops ONLY the additional instances (GPUs 1-7 / ports 8189-8195).
# Deliberately does not touch the 8188 instance or the TTS server.
set -uo pipefail

COMFY_ROOT="${COMFY_ROOT:-/root/comfy}"
VENV_PYTHON="${COMFY_ROOT}/venv/bin/python"
HOST="0.0.0.0"
GPU_IDS="${COMFY_GPU_IDS:-1 2 3 4 5 6 7}"

proc_pids() {
    local pattern="$1" pid
    for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
        case "$(readlink -f "/proc/${pid}/exe" 2>/dev/null)" in
            */python3*|*/python) echo "$pid" ;;
        esac
    done
}

for i in $GPU_IDS; do
    port=$((8188 + i))
    pattern="${VENV_PYTHON} main.py --listen ${HOST} --port ${port}"
    pids=$(proc_pids "$pattern")
    if [ -z "$pids" ]; then
        echo "ComfyUI GPU ${i} (port ${port}) not running."
        continue
    fi
    echo "Stopping ComfyUI GPU ${i} (port ${port}) (PID(s): $(echo "$pids" | tr '\n' ' '))..."
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 30); do
        [ -z "$(proc_pids "$pattern")" ] && break
        sleep 0.5
    done
    pids=$(proc_pids "$pattern")
    if [ -n "$pids" ]; then
        kill -9 $pids 2>/dev/null
        echo "ComfyUI GPU ${i} (port ${port}) stopped (forced)."
    else
        echo "ComfyUI GPU ${i} (port ${port}) stopped."
    fi
done
