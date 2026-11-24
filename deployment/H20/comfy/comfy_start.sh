#!/usr/bin/env bash
set -euo pipefail

# COMFY_ROOT is the only path knob: everything below derives from it, so a new
# host can install the stack anywhere (default keeps the reference layout).
COMFY_ROOT="${COMFY_ROOT:-/root/comfy}"
COMFY_DIR="${COMFY_ROOT}/ComfyUI"
VENV_PYTHON="${COMFY_ROOT}/venv/bin/python"
LOG_DIR="${COMFY_ROOT}/log"
HOST="0.0.0.0"
PORT="8188"

TTS_PYTHON="${COMFY_ROOT}/venv-cosy/bin/python"
TTS_SCRIPT="${COMFY_ROOT}/script/cosyvoice_tts_server.py"
TTS_SOCKET="${COSY_UDS:-${COMFY_ROOT}/log/tts.sock}"

COMFY_PATTERN="${VENV_PYTHON} main.py --listen ${HOST} --port ${PORT}"
TTS_PATTERN="${TTS_PYTHON} ${TTS_SCRIPT}"

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

mkdir -p "$LOG_DIR"

if proc_running "$COMFY_PATTERN"; then
    echo "ComfyUI already running on port ${PORT}."
else
    cd "$COMFY_DIR"
    nohup "$VENV_PYTHON" main.py \
        --listen "$HOST" \
        --port "$PORT" \
        > "$LOG_DIR/comfyui.log" 2>&1 &
    echo "ComfyUI starting on http://${HOST}:${PORT} (PID $!)"
fi

if proc_running "$TTS_PATTERN"; then
    echo "CosyVoice2 TTS already running (socket ${TTS_SOCKET})."
else
    cd "$COMFY_ROOT"
    CUDA_VISIBLE_DEVICES=0 nohup "$TTS_PYTHON" "$TTS_SCRIPT" \
        > "$LOG_DIR/cosy_tts_server.log" 2>&1 &
    echo "CosyVoice2 TTS starting on unix socket ${TTS_SOCKET} (PID $!)"
fi

comfy_ok=0
tts_ok=0
for _ in $(seq 1 180); do
    if [ "$comfy_ok" = 0 ] && curl -sf -m 2 "http://127.0.0.1:${PORT}/system_stats" > /dev/null 2>&1; then
        comfy_ok=1
    fi
    if [ "$tts_ok" = 0 ] && curl -sf -m 2 --unix-socket "$TTS_SOCKET" "http://localhost/health" > /dev/null 2>&1; then
        tts_ok=1
    fi
    [ "$comfy_ok" = 1 ] && [ "$tts_ok" = 1 ] && break
    sleep 1
done

[ "$comfy_ok" = 1 ] && echo "ComfyUI ready (8188)." || echo "WARNING: ComfyUI not ready after 180s (see ${LOG_DIR}/comfyui.log)."
[ "$tts_ok" = 1 ] && echo "CosyVoice2 TTS ready (unix socket, model loads on first request)." || echo "WARNING: CosyVoice2 TTS not ready after 180s (see ${LOG_DIR}/cosy_tts_server.log)."

# Additional fleet instances: GPU 1-7 -> ports 8189-8195.
# Failures here must not change the exit status of the 8188/TTS startup above.
"${COMFY_ROOT}/comfy_start_multi.sh" || echo "WARNING: some fleet instances failed to start (see ${LOG_DIR}/comfyui-81xx.log)."

[ "$comfy_ok" = 1 ] && [ "$tts_ok" = 1 ]
