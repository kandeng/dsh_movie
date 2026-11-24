#!/usr/bin/env bash
# Launches additional ComfyUI instances on GPUs 1-7 (ports 8189-8195).
# Mirrors the supervision model of comfy_start.sh (nohup, no systemd dependency):
# each instance gets its own output + user directory so filenames and the
# sqlite db never collide, while /root/comfy/ComfyUI/models stays shared.
set -uo pipefail

COMFY_ROOT="${COMFY_ROOT:-/root/comfy}"
COMFY_DIR="${COMFY_ROOT}/ComfyUI"
VENV_PYTHON="${COMFY_ROOT}/venv/bin/python"
LOG_DIR="${COMFY_ROOT}/log"
HOST="0.0.0.0"
GPU_IDS="${COMFY_GPU_IDS:-1 2 3 4 5 6 7}"
BOOT_TIMEOUT="${COMFY_BOOT_TIMEOUT:-180}"

mkdir -p "$LOG_DIR"

# Match only real python processes (ignore shells whose command line happens to contain the pattern).
proc_running() {
    local pattern="$1" pid
    for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
        case "$(readlink -f "/proc/${pid}/exe" 2>/dev/null)" in
            */python3*|*/python) return 0 ;;
        esac
    done
    return 1
}

rc=0
for i in $GPU_IDS; do
    port=$((8188 + i))
    pattern="${VENV_PYTHON} main.py --listen ${HOST} --port ${port}"
    if proc_running "$pattern"; then
        echo "ComfyUI on GPU ${i} (port ${port}) already running."
        continue
    fi

    mkdir -p "${COMFY_ROOT}/output-${i}" "${COMFY_ROOT}/user-${i}"
    cd "$COMFY_DIR"
    CUDA_VISIBLE_DEVICES=$i setsid nohup "$VENV_PYTHON" main.py \
        --listen "$HOST" \
        --port "$port" \
        --output-directory "${COMFY_ROOT}/output-${i}" \
        --user-directory  "${COMFY_ROOT}/user-${i}" \
        > "$LOG_DIR/comfyui-${port}.log" 2>&1 </dev/null &
    echo "ComfyUI GPU ${i} starting on ${HOST}:${port} (PID $!), log ${LOG_DIR}/comfyui-${port}.log"

    ok=0
    for _ in $(seq 1 "$BOOT_TIMEOUT"); do
        if curl -sf -m 2 "http://127.0.0.1:${port}/system_stats" > /dev/null 2>&1; then
            ok=1
            break
        fi
        sleep 1
    done

    if [ "$ok" = 1 ]; then
        echo "ComfyUI GPU ${i} ready (${port})."
    else
        echo "WARNING: ComfyUI GPU ${i} not ready after ${BOOT_TIMEOUT}s (see ${LOG_DIR}/comfyui-${port}.log)."
        rc=1
    fi
done

exit $rc
