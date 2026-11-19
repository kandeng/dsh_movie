# ComfyUI GPU media backend — local operations log

Phase 8 (P8-M1) operations record. Design: `doc/design/phase8-comfyui-gpu-media-backend.md`
(rev 2, local-first D13). This doc records the install/provisioning commands **as
executed** on the local Ubuntu box, per D11.

> **Scope note (user directive, updated):** initially ComfyUI-only with no
> models; later the user approved downloading ONE small image-generation
> model (SD1.5 fp16, ~2 GB) to smoke-test ComfyUI. Video weights (LTX-Video /
> t5xxl) remain deferred; until they are added, video stays `unavailable`
> under the gateway's fail-closed health gate.

## 1. Host envelope (recon)

| Item | Value |
|---|---|
| GPU | NVIDIA GeForce RTX 3070 Ti **Laptop**, 8192 MiB (Ampere sm_86) |
| Driver | 550.144.03 (CUDA 12.4 runtime ceiling) |
| OS / Python | Ubuntu 22.04, Python 3.12.7 |
| RAM / disk | 31 GB / ~456 GB free |
| Node | v24.14.0 (DSH server) |

## 2. Install commands (as executed)

ComfyUI lives OUTSIDE the repo at `/home/robot/ComfyUI` (pre-existing v0.45.0
clone, grafted master `1e71927`); the DSH process stays model-code-free (D2).

```bash
# venv (pre-existing) + torch cu124 — first pass
/home/robot/ComfyUI/venv/bin/pip install \
  torch==2.6.0 torchvision==0.21.0 torchaudio==2.6.0 \
  --index-url https://download.pytorch.org/whl/cu124
# CUDA verified: torch.cuda.is_available() == True on the 3070 Ti

# ComfyUI requirements (tuna mirror + PyPI fallback; the mirror alone dropped
# `tokenizers` transiently — the fallback index fixed it)
/home/robot/ComfyUI/venv/bin/pip install -r /home/robot/ComfyUI/requirements.txt \
  -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --extra-index-url https://pypi.org/simple --retries 8 --timeout 120
```

### 2.1 torch version correction

First boot of v0.45.0 crashed in `comfy_kitchen.backends.eager.conv3d`:
`torch.library.infer_schema` rejects PEP-695 `list[int]` annotations on
torch 2.6. ComfyUI v0.45.0 therefore needs **torch ≥ 2.7**.

Version selection on driver 550.144.03:

- `torch==2.7.1` from a mixed index resolved to the **cu126** build — its
  runtime fails `cuInit` on this driver (error 999).
- `torch==2.7.1+cu124` **does not exist** (the cu124 line ends at 2.6.0).
- Final choice: **`torch==2.7.1+cu118`** — CUDA 11.8 is fully compatible with
  driver 550 and sm_86, and satisfies ComfyUI's ≥ 2.7 requirement:

```bash
/home/robot/ComfyUI/venv/bin/pip install \
  torch==2.7.1+cu118 torchvision==0.22.1+cu118 torchaudio==2.7.1+cu118 \
  --index-url https://download.pytorch.org/whl/cu118 --retries 8 --timeout 120
# Successfully installed torch-2.7.1+cu118 torchvision-0.22.1+cu118 torchaudio-2.7.1+cu118
```

### 2.2 GPU fault state — RESOLVED by reboot

After the installs, CUDA init began failing **system-wide** (error 999) —
reproduced with raw `libcuda` `cuInit` AND NVIDIA's own
`/usr/local/cuda-12.4/extras/demo_suite/deviceQuery`, i.e. independent of
torch/ComfyUI. Kernel log showed `NVRM: Xid 31 … MMU Fault` and repeated
`Failed to grab modeset ownership`; the nvidia module held 223 references
(Xorg/desktop), so it could not be reloaded live. **The user rebooted the
machine; CUDA recovered fully** (`cuInit: 0`, torch allocation OK, ~7.98 GB
VRAM free).

## 3. Model provisioning — SD1.5 only (video deferred)

Per the updated user directive, one small image model is provisioned for the
smoke test; the video inventory stays deferred. The 8 GB-envelope reference
(R6/R10):

| File | Target dir | Size | Status |
|---|---|---|---|
| `v1-5-pruned-emaonly-fp16.safetensors` (SD1.5 fp16) | `models/checkpoints/` | ~2.0 GB | ✅ downloaded + verified (2,132,696,762 bytes, 1145 tensors) |
| `ltx-video-2b-v0.9.5.safetensors` (LTX-Video 2B) | `models/checkpoints/` | ~6.0 GB | deferred |
| `t5xxl_fp8_e4m3fn.safetensors` (fp8 storage-only on sm_86) | `models/text_encoders/` | ~4.7 GB | deferred |

The server-held templates (`comfy-templates/image.json`, `video.json`) already
reference these exact file names, so provisioning is drop-in.

## 4. Start + probes (loopback, D13)

```bash
cd /home/robot/ComfyUI
venv/bin/python main.py --listen 127.0.0.1 --port 8188
# NOTE: v0.45.0 removed --medvram (smart memory management is the default);
# passing it errors with "unrecognized arguments". A cu130-upgrade notice is
# printed at boot but is advisory only — cu118 runs correctly on driver 550.
```

Health probes (the same surface the gateway's P8-M5 probe drives):

```bash
curl -s http://127.0.0.1:8188/system_stats
curl -s http://127.0.0.1:8188/object_info   # template node-type coverage
```

### 4.1 Executed results (post-reboot)

- `/system_stats`: comfyui_version 0.45.0, device `cuda:0 NVIDIA GeForce
  RTX 3070 Ti Laptop GPU : cudaMallocAsync`.
- `/object_info`: **1062 node types; zero missing** for BOTH bundled templates
  (image + video node coverage) → provider probe `{image:true, video:true}`.
- **Real image smoke test** through `createComfyProvider` (the M2 seam itself):
  prompt "a cinematic photo of a teal ocean at sunset", seed 42, 512×512,
  20 steps → `dsh-movie_00001_.png`, **447,052 bytes, valid 512×512 RGB PNG**;
  ComfyUI log: `20/20 [00:02<00:00, 9.70it/s]`, `Prompt executed in 3.88
  seconds`; provider round-trip 4.5 s; **12 `/ws` progress frames → 100%**;
  peak VRAM ≈ 2.4 GB of 8 GB (R6 envelope holds with wide margin).
- Video generation remains untested until the LTX-Video + t5xxl weights are
  provisioned (deferred); the gate's node-coverage probe passes, but a real
  video job would fail at checkpoint load — honest failure, no silent canned.

## 5. Gateway configuration (env-only switch, D2/D13)

```bash
DSH_COMFY_BASE_URL=http://127.0.0.1:8188   # required to arm the provider
# optional:
DSH_COMFY_POOL=http://host2:8188           # extra endpoints (round-robin)
DSH_COMFY_TOKEN=...                      # when ComfyUI runs with --api-key
DSH_COMFY_POLL_MS=1500                   # history poll spacing
DSH_COMFY_TIMEOUT_MS=900000              # 8GB envelope: 15 min per generation
DSH_COMFY_INFLIGHT_MAX=1                 # one concurrent GPU job
```

Remote-GPU migration later is an env-only change (`DSH_COMFY_BASE_URL` →
the remote host); no code change (D13).

## 6. Verification

Offline (no GPU/models needed): `cd server && pnpm verify:comfy` — 36 checks
against mock ComfyUI fixtures covering M2 routing/templates, M3 media pipeline,
M4 progress/interrupt/timeout/cap, M5 fail-closed probe + pooling.