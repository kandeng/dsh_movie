#!/usr/bin/env bash
# Fresh-box acceptance gate for the movie ComfyUI stack.
#
# Mandatory checks (no model VRAM needed):
#   1. ComfyUI  GET /system_stats        -> HTTP 200, reports >=1 CUDA device
#   2. ComfyUI  GET /model_catalog       -> HTTP 200, non-empty catalog
#   3. CosyVoice2 GET /health (unix sock)-> HTTP 200 (model_loaded may be false; it is lazy)
# Optional:
#   --with-prompt  submit a small SDXL 512x512 /prompt and wait for success
#                  (loads ~9 GB VRAM on first run; skip on boxes without headroom)
#
# Env: COMFY_ROOT (default /root/comfy), COMFY_PORT (default 8188), COSY_UDS (tts socket)
# Exit 0 = all mandatory checks passed.
set -uo pipefail

COMFY_ROOT="${COMFY_ROOT:-/root/comfy}"
PORT="${COMFY_PORT:-8188}"
SOCK="${COSY_UDS:-${COMFY_ROOT}/log/tts.sock}"
BASE="http://127.0.0.1:${PORT}"
WITH_PROMPT=0
[ "${1:-}" = "--with-prompt" ] && WITH_PROMPT=1

fail=0
note() { printf '%-8s %s\n' "$1" "$2"; }

# 1) system_stats
stats=$(curl -sf -m 10 "${BASE}/system_stats" 2>/dev/null) || stats=""
if [ -z "$stats" ]; then
    note FAIL "GET ${BASE}/system_stats (is ComfyUI up on ${PORT}?)"
    fail=1
else
    ndev=$(printf '%s' "$stats" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["devices"]))' 2>/dev/null || echo 0)
    if [ "${ndev:-0}" -ge 1 ] 2>/dev/null; then
        note PASS "system_stats (${ndev} CUDA device(s))"
    else
        note FAIL "system_stats reports no CUDA devices"
        fail=1
    fi
fi

# 2) model_catalog
cat_json=$(curl -sf -m 10 "${BASE}/model_catalog" 2>/dev/null) || cat_json=""
if [ -z "$cat_json" ]; then
    note FAIL "GET ${BASE}/model_catalog (is the model_catalog custom node installed?)"
    fail=1
else
    nmodels=$(printf '%s' "$cat_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d if isinstance(d,list) else d.get("models",[])))' 2>/dev/null || echo 0)
    if [ "${nmodels:-0}" -ge 1 ] 2>/dev/null; then
        note PASS "model_catalog (${nmodels} entries)"
    else
        note FAIL "model_catalog empty (models not provisioned? run download_models.sh --check-only)"
        fail=1
    fi
fi

# 3) TTS health over the unix socket
if [ -S "$SOCK" ]; then
    tts=$(curl -sf -m 10 --unix-socket "$SOCK" http://localhost/health 2>/dev/null) || tts=""
    if [ -n "$tts" ]; then
        note PASS "tts /health (socket ${SOCK})"
    else
        note FAIL "tts /health no response on ${SOCK}"
        fail=1
    fi
else
    note FAIL "tts socket ${SOCK} missing (TTS service not running?)"
    fail=1
fi

# 4) optional SDXL smoke prompt
if [ "$WITH_PROMPT" = 1 ]; then
    pid=$(curl -sf -m 20 -X POST "${BASE}/prompt" -H 'Content-Type: application/json' -d '{
     "prompt": {
      "1": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"sd_xl_base_1.0.safetensors"}},
      "2": {"class_type":"CLIPTextEncode","inputs":{"text":"verify smoke","clip":["1",1]}},
      "3": {"class_type":"CLIPTextEncode","inputs":{"text":"blurry","clip":["1",1]}},
      "4": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512,"batch_size":1}},
      "5": {"class_type":"KSampler","inputs":{"model":["1",0],"positive":["2",0],"negative":["3",0],"latent_image":["4",0],
             "seed":1,"steps":4,"cfg":7.0,"sampler_name":"euler","scheduler":"normal","denoise":1.0}},
      "6": {"class_type":"VAEDecode","inputs":{"samples":["5",0],"vae":["1",2]}},
      "7": {"class_type":"SaveImage","inputs":{"images":["6",0],"filename_prefix":"verify_smoke"}}
     }}' 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("prompt_id",""))' 2>/dev/null)
    if [ -z "$pid" ]; then
        note FAIL "smoke /prompt rejected (SDXL checkpoint missing?)"
        fail=1
    else
        st=""
        for _ in $(seq 1 120); do
            st=$(curl -sf -m 10 "${BASE}/history/${pid}" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("'${pid}'",{}).get("status",{}).get("status_str",""))' 2>/dev/null)
            [ "$st" = "success" ] && break
            [ "$st" = "error" ] && break
            sleep 1
        done
        if [ "$st" = "success" ]; then note PASS "smoke /prompt ${pid} success"; else note FAIL "smoke /prompt ${pid} status=${st:-timeout}"; fail=1; fi
    fi
fi

if [ "$fail" = 0 ]; then
    echo "VERIFY OK (port ${PORT})"
else
    echo "VERIFY FAILED (port ${PORT}) — see FAIL lines above"
fi
exit "$fail"
