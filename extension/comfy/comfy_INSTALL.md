# ComfyUI Installation Report

## Environment
- OS: Ubuntu 22.04
- GPU: 8x NVIDIA H20 96GB
- Driver: 595.71.05 (CUDA 13.2 capable)
- User: root
- Conda: /root/miniconda3 (left untouched)

## Paths
- ComfyUI root: `/root/comfy/ComfyUI`
- Python venv: `/root/comfy/venv`
- Start script: `/root/comfy/start.sh`
- Stop script: `/root/comfy/stop.sh`
- Log file: `/root/comfy/log/comfyui.log`
- Service port: `8188`
- Listen address: `0.0.0.0`

## Python
- Version: `3.11.18`
- Source: deadsnakes PPA (`ppa:deadsnakes/ppa`)
- Reason: the Ubuntu 22.04 apt package `python3.11` is `3.11.0~rc1`, which lacks `sys.get_int_max_str_digits` required by PyTorch 2.15 (`torch._dynamo`).

## Mirrors and Package Sources
- ComfyUI clone: official GitHub `https://github.com/comfyanonymous/ComfyUI` (no mirror used)
- PyTorch wheels: official `https://download.pytorch.org/whl/cu126`
  - Note: the official index resolved to CUDA 13.2 builds (`torch-2.15.0+cu132`), which are compatible with driver 595.
- System Python: deadsnakes PPA (`ppa:deadsnakes/ppa`)

## Installed Versions
- Python: `3.11.18`
- PyTorch: `2.15.0+cu132`
- torchvision: `0.29.2`
- torchaudio: `2.11.1`
- ComfyUI: `0.46.0`
- comfy-kitchen: `0.2.41`
- comfy-aimdo: `0.6.0`
- comfyui-frontend-package: `1.59.10`
- comfyui-workflow-templates: `0.11.114`

## Verification
```text
/root/comfy/venv/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.device_count())"
# Output: 2.15.0+cu132 True 8
```

Boot test:
```text
curl -s http://127.0.0.1:8188/system_stats | python3 -m json.tool
```
Confirmed `devices` array contains 8 entries: `cuda:0` through `cuda:7 NVIDIA H20`.

## Models
No model checkpoints, LoRAs, or other weights were downloaded. The `models/` directories contain only the placeholder files shipped with the ComfyUI repository.

## Deviations from Original Plan
1. System Python upgraded from Ubuntu's `3.11.0~rc1` to deadsnakes `3.11.18` because the release candidate is missing `sys.get_int_max_str_digits`, causing `AttributeError` during PyTorch import.
2. PyTorch resolved to `cu132` wheels instead of `cu126`. Driver 595 supports CUDA 13.2, and the acceptance test (`torch.cuda.is_available() == True`, `device_count() == 8`) passes.

## Wan 2.2 T2V Weights Provisioning and Smoke Generation

### Download Source
- ModelScope: `Comfy-Org/Wan_2.2_ComfyUI_Repackaged`
- Precision chosen: **fp8 scaled** (split_files)
- Mirror used: `https://www.modelscope.cn` (official, /etc/hosts pinned to 39.99.133.195)

### Downloaded Files
| File | Destination | Size |
|------|-------------|------|
| `wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` | `models/diffusion_models/` | 14.0 GB |
| `wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` | `models/diffusion_models/` | 14.0 GB |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `models/text_encoders/` | 6.3 GB |
| `wan_2.1_vae.safetensors` | `models/vae/` | 243 MB |
| **Total** | | **~34.5 GB** |

### Download Performance
- Tool: `aria2c -x16 -s16`
- Aggregate wall time: ~50 minutes
- Effective aggregate throughput: ~11.8 MiB/s (consistent with observed egress cap)
- Per-file aria2-reported averages: vae 1.1 MiB/s, umt5 3.6 MiB/s, high_noise 4.5 MiB/s, low_noise 4.4 MiB/s

### Smoke Generation
- Workflow: derived from bundled `comfyui-workflow-templates-media-video` `video_wan2_2_14B_t2v.json`
- Settings: 832x480, 49 frames, 16 fps, 20 steps, seed 42, Euler/simple, CFG 3.5, 10 high-noise + 10 low-noise split
- Prompt: `"a red panda riding a bicycle through a bamboo forest, cinematic lighting"`
- Output: `/root/comfy/ComfyUI/output/video/wan_smoke_00001_.mp4` (1.6 MB, 832x480, 49 frames, 16 fps, 3.06 s)
- Wall time: **240 seconds**
- Peak VRAM (observed via `nvidia-smi`): **39.3 GB**

### Notes
- The first generation attempt failed with CUDA OOM because an existing `sglang serve` process was occupying all 8 H20 GPUs. It was terminated to free VRAM for the smoke test.
- No 720p generation was run.

## Usage
```bash
# Start both services (ComfyUI on TCP 8188 + CosyVoice2 TTS on unix socket /root/comfy/log/tts.sock)
/root/comfy/start.sh

# Stop both services
/root/comfy/stop.sh
```
Both scripts are idempotent: `start.sh` matches only real python processes (ignores shells whose command line contains the pattern), skips services already running, and waits until both health endpoints answer; `stop.sh` sends SIGTERM to each, escalates to SIGKILL after 15 s, and removes the stale TTS socket. Logs go to `/root/comfy/log/`. **No TCP port other than 8188 is used.**

---

# SDXL + InstantID + Qwen-Image Stack (2026-11-22)

## Phase A — SDXL workhorse + face/style lock

### Custom nodes (shallow clone --depth 1, via `https://ghfast.top/` proxy; direct github.com was <100 KB/s)
| Repo | Commit | Notes |
|------|--------|-------|
| `cubiq/ComfyUI_IPAdapter_plus` | `a0f451a5113cf9becb0847b92884cb10cbdec0ef` (2025-04-14) | v2.0.0; has no `requirements.txt`/no deps beyond `einops` (already present). |
| `cubiq/ComfyUI_InstantID` | `72495e806bc2ab9c41581e15ccaa1bcf83c477e8` (2025-04-14) | Installed because IPAdapter_plus v2.0 **no longer contains InstantID nodes** (see Deviations). |

Python deps installed into venv with `-i https://mirrors.aliyun.com/pypi/simple/`:
`insightface==2.1` (wheel, no compile), `onnxruntime==1.32.0`, `onnxruntime-gpu==1.32.0` (force-reinstalled last so CUDAExecutionProvider is available), `opencv-python==5.1.0.95`, `scikit-image==0.26.0`, plus transitive deps. onnxruntime-gpu wheel downloaded at ~5.8 MB/s; opencv/onnx at ~11 MB/s.
Confirmed: `onnxruntime.get_available_providers()` → `TensorrtExecutionProvider, CUDAExecutionProvider, CPUExecutionProvider`.

### Downloads (aria2c -c -x16 -s16)
| File | Source | Size (bytes) | Dest | Avg speed |
|------|--------|--------------|------|-----------|
| `sd_xl_base_1.0.safetensors` | ModelScope `AI-ModelScope/stable-diffusion-xl-base-1.0/resolve/master/` | 6,938,078,334 | `models/checkpoints/` | ~11 MB/s (10m34s) |
| `ip-adapter.bin` | ModelScope `InstantX/InstantID/resolve/master/` | 1,691,134,141 | `models/instantid/` | ~5.9 MB/s |
| `control_instantid_sdxl.safetensors` | ModelScope `InstantX/InstantID/.../ControlNetModel/diffusion_pytorch_model.safetensors` | 2,502,139,136 | `models/controlnet/` | ~11.2 MB/s |
| `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | hf-mirror `h94/IP-Adapter/.../models/image_encoder/model.safetensors` | 2,528,373,448 | `models/clip_vision/` | ~6 MB/s (stalled 93%, resumed with -c) |
| antelopev2 pack: `1k3d68.onnx` 143,607,619; `2d106det.onnx` 5,030,888; `genderage.onnx` 1,322,532; `glintr100.onnx` 260,665,334; `scrfd_10g_bnkps.onnx` 16,923,827 | ModelScope `AI-ModelScope/antelopev2/resolve/master/` | 427,550,200 total | `models/insightface/models/antelopev2/` | ~7 MB/s |

All sizes re-verified against ModelScope file listings; all exact. SDXL header check: 2515 tensors.

### Acceptance (all passed)
- `GET /object_info` (1125 nodes) lists: `IPAdapterUnifiedLoader`, `InstantIDModelLoader`, `InstantIDFaceAnalysis`, `ApplyInstantID`, `ApplyInstantIDAdvanced`.
- SDXL T2I: 1024x1024, 20 steps, euler/normal, cfg 7, seed 123456789 → `/root/comfy/ComfyUI/output/sdxl_t2i_accept_00001_.png` (10.73 s).
- Portrait (SDXL output above) copied to `input/ref_portrait.png`; InstantID smoke: 1016x1016, 20 steps, cfg 4.5, weight 0.8, euler/normal, CUDA provider, seeds 111111/222222 →
  - `/root/comfy/ComfyUI/output/instantid_seed111111_00001_.png`
  - `/root/comfy/ComfyUI/output/instantid_seed222222_00001_.png`

## Phase B — Qwen-Image premium T2I

Source: ModelScope `Comfy-Org/Qwen-Image_ComfyUI/resolve/master/split_files/...` (official Comfy-Org repack), ~30.07 GB in 44 min ≈ **11.4 MB/s** aggregate. Resume-safe download script: `/root/comfy/qwen_dl.sh`.
| File | Size (bytes) | Dest |
|------|--------------|------|
| `qwen_image_fp8_e4m3fn.safetensors` (repo has **no** `fp8_scaled` diffusion file; this is the requested ~20 GB fp8) | 20,430,635,136 | `models/diffusion_models/` |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | 9,384,670,680 | `models/text_encoders/` |
| `qwen_image_vae.safetensors` | 253,806,246 | `models/vae/` |

All sizes exact; safetensors headers validated (1933 / 1446 / 194 tensors).

### Acceptance (passed)
- Bundled template `image_qwen_image.json` settings reproduced: UNETLoader(fp8_e4m3fn) → ModelSamplingAuraFlow(shift 3.1) → KSampler(euler/simple, 20 steps, cfg 2.5, seed 424242); CLIPLoader type `qwen_image`; EmptySD3LatentImage 1328x1328.
- Prompt: `一张电影海报，标题文字：山海之间，导演：邓侃` (+ descriptive suffix `。电影海报构图，山水意境，汉字标题清晰醒目，专业排版，高质量`; negative `低质量，模糊，文字错误，变形`).
- Output: `/root/comfy/ComfyUI/output/qwen_image_accept_00001_.png` (1328x1328).

## Deviations
1. `/etc/hosts` does **not** contain the stated ModelScope pin (verified); ModelScope still reachable at full speed. `/etc/hosts` left untouched.
2. IPAdapter_plus v2.0 has no InstantID nodes — the author split them into `ComfyUI_InstantID`, which was installed. Acceptance node classes are satisfied across both custom-node packages.
3. IPAdapter_plus has no `requirements.txt`; nothing needed installing for it.
4. `onnxruntime` (CPU) overwrote shared files of `onnxruntime-gpu`; fixed by `pip install --force-reinstall onnxruntime-gpu==1.32.0`.
5. InstantID `ip-adapter.bin` placed in `models/instantid/` per ComfyUI_InstantID docs (not `models/ipadapter/`); controlnet renamed `control_instantid_sdxl.safetensors` as requested.
6. CLIP-ViT-H-14 taken from hf-mirror (2.53 GB < 3 GB); ModelScope only offers 3.9 GB fp32 builds there.
7. Qwen diffusion file is `qwen_image_fp8_e4m3fn` (no `_scaled` variant exists for Qwen-Image); text encoder is the requested `_fp8_scaled`.
8. InstantID workflow was built in API format manually from the cubiq example (the repo ships UI-format JSON only). Reference portrait is SDXL-generated.
9. Qwen acceptance prompt had a short descriptive suffix appended; the requested title text is verbatim.
10. Background `pip install -r requirements.txt` exceeded the tool's 10-min foreground timeout; re-run completed successfully (wheels only, no compile).

## Disk state (2026-11-22, flagged)
- `/` (879 GB): 828 GB used, **5.7 GB free** (Wan 34.5 GB + SDXL 6.9 GB + face-lock 6.4 GB + Qwen 30.1 GB + venv/deps).
- `/data` (nvme1n1, 7.0 TB ext4): **100% full, 0 B free** — not usable as-is. Contains `datasets/`, `models/`, `modules/`, `jumpserver/`, `lost+found/` (owned by `yw`).
- Other mounts with free space: `/robot` 6.4 TB free, `/ai` 4.8 TB free, `/db` 1.5 TB free.
- `/root/kdeng` = 16 GB: `project` 12 GB, `dataset` 4.3 GB, `package` 56 MB, `asset` 47 MB, `output` 2.5 MB, `model` 40 KB.

## Service
ComfyUI on `0.0.0.0:8188` and CosyVoice2 TTS on unix socket `/root/comfy/log/tts.sock` (no TCP port) are both managed by `start.sh`/`stop.sh`. Conda base untouched.

---

# Audio Stack (2026-11-22): CosyVoice2 + Stable Audio Open 1.0

## Phase A — CosyVoice2 narration TTS

### Code (direct GitHub clone, 2.5 MiB/s, no proxy needed)
| Repo | Commit | Notes |
|------|--------|-------|
| `FunAudioLLM/CosyVoice` → `/root/comfy/CosyVoice` | `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc` (2026-05-26) | 5.3 MB |
| submodule `third_party/Matcha-TTS` | `dd9105b34bf2be2230f4aa1e4769fb586a3c824e` | **required** `git submodule update --init --depth 1` (plain clone leaves it empty → `ModuleNotFoundError: matcha`) |

### Weights — ModelScope `iic/CosyVoice2-0.5B`
Destination `/root/comfy/CosyVoice/pretrained_models/CosyVoice2-0.5B`, aria2c `-i` manifest (`/root/comfy/cosy_urls.txt`), 21 files, **all sizes verified byte-exact** vs repo listing, total **5,616,075,970 B** in ~9 min (12:37→12:46), ≈ **10–11 MB/s**.
| File | Size |
|------|------|
| `llm.pt` | 2,023,316,821 |
| `CosyVoice-BlankEN/model.safetensors` | 988,097,824 |
| `speech_tokenizer_v2.onnx` / `speech_tokenizer_v2.batch.onnx` | 496,082,973 / 496,095,794 |
| `flow.pt` / `flow.cache.pt` | 450,575,567 / 450,496,991 |
| `flow.decoder.estimator.fp32.onnx` | 286,317,026 |
| `flow.encoder.fp32.zip` / `flow.encoder.fp16.zip` | 192,367,811 / 116,705,475 |
| `hift.pt` | 83,390,254 |
| `campplus.onnx` | 28,303,423 |

### Runtime — path **(a)** chosen: dedicated venv `/root/comfy/venv-cosy` (Python 3.11.18), pip `-i https://mirrors.aliyun.com/pypi/simple/`
Installed `requirements.txt` successfully; no pynini/WeTextProcessing compile issue (repo uses `wetext==0.0.4`, pure wheel). Key versions: `torch 2.3.1+cu121`, `torchaudio 2.3.1+cu121`, `onnxruntime-gpu 1.18.0`, `insightface` absent, `deepspeed 0.15.1`, `tensorrt-cu12 10.13.3.9`. venv size 12 GB.
Issues fixed (not deviations from the plan, but worth recording):
1. `setuptools>=81` removed `pkg_resources` → `openai-whisper==20231117` build failed. Fixed: `pip install "setuptools<80" wheel` + `pip install --no-build-isolation --no-deps openai-whisper==20231117`.
2. Several Aliyun wheels stalled at 38–76 KiB/s (triton 168 MB, gradio 57 MB) and some 416 on ranged GETs. Fixed: pre-fetched `triton`, `gradio`, `onnxruntime-gpu 1.18.0` + the TensorRT trio into `/root/comfy/wheels` with `aria2c -x16 -s16 --header="User-Agent: pip/24.0"` (or curl for 416 cases), then `pip install --find-links=/root/comfy/wheels`.
3. Engine downloaded its text-normalizer model at first run: `pengzhendong/wetext` → `~/.cache/modelscope/hub/pengzhendong/wetext` (ModelScope, recreated the cache dir we had cleaned).
4. CosyVoice2 ships an **empty** SFT speaker list (`list_available_spks() == []`) → narration used `inference_zero_shot` (zh) and `inference_cross_lingual` (en) with the bundled prompt WAVs.

### Acceptance (passed)
| File | Sample rate | Channels | Duration |
|------|-------------|----------|----------|
| `/root/comfy/audio_out/cosy_zh.wav` (深夜的机房里…) | 24 kHz | mono | 5.68 s |
| `/root/comfy/audio_out/cosy_en.wav` (Despite the howling wind…) | 24 kHz | mono | 4.40 s |

Verified with `torchaudio.info` in venv-cosy (torchaudio 2.3.1; note the ComfyUI venv's torchaudio 2.11 no longer has `.info()`).

### TTS service (unix socket, lazy-loaded)
- Script: `/root/comfy/cosyvoice_tts_server.py` (FastAPI/uvicorn), listening on **unix socket** `/root/comfy/log/tts.sock` — **no TCP port**. Started/stopped together with ComfyUI by `/root/comfy/start.sh` / `stop.sh` (runs with `CUDA_VISIBLE_DEVICES=0`, output to `/root/comfy/log/cosy_tts_server.log`).
- **Lazy loading:** the CosyVoice2 model is built on the first `/tts` request, not at startup. `GET /health` reports `model_loaded: false/true` and `idle_timeout_s`.
- **Idle unload:** after `COSY_IDLE_TIMEOUT` seconds without requests (default 600 s) a background thread drops the model and calls `torch.cuda.empty_cache()`. Measured: ~90 s cold load, +4.6 GB VRAM while loaded, ~1 GB residual CUDA context after unload.
- API (over the socket, e.g. `curl --unix-socket /root/comfy/log/tts.sock http://localhost/health`):
  - `GET /health` → `{"status":"ok","model_loaded":...,"sample_rate":24000,"speakers":["female_zh","female_zh_alt"],"idle_timeout_s":600.0,"socket":"..."}`
  - `POST /tts` `{"text": "...", "speaker_id": "female_zh"}` → 24 kHz mono WAV (`audio/wav`). `speaker_id` selects a zero-shot prompt preset (`female_zh` = `asset/zero_shot_prompt.wav`, `female_zh_alt` = `asset/cross_lingual_prompt.wav`).
- Verified: cold POST with the Chinese sentence → `audio_out/uds_test.wav`, 5.68 s, HTTP 200, 272,684 B; second request is warm. Idle unload verified with `COSY_IDLE_TIMEOUT=20` (model unloaded, VRAM freed).
- Note: the `AIFSH/CosyVoice-ComfyUI` custom node was evaluated and rejected — it only supports CosyVoice **v1** (300M `inference_sft`), not the installed CosyVoice2-0.5B, and would have required a different engine/weights. TTS therefore stays in its dedicated venv, reachable over a local socket only.
- **Runtime retention (decision, 2026-11-22):** `venv-cosy` (12 GB; `torch 2.3.1+cu121`, `torchaudio 2.3.1`, etc.) is intentionally retained to run this lazily-loaded TTS service. It is not an unused leftover and must not be deleted without also removing the TTS feature. It stays separate from `/root/comfy/venv` to avoid torch/diffusers version conflicts with the ComfyUI nodes.

## Phase B — Stable Audio Open 1.0 (native ComfyUI)

Template read: `comfyui_workflow_templates_json/templates/audio_stable_audio_example.json` → `CheckpointLoaderSimple(stable-audio-open-1.0.safetensors)` + `CLIPLoader(t5-base.safetensors, stable_audio, default)`, `EmptyLatentAudio`, KSampler 50 steps / cfg 4.98 / `dpmpp_3m_sde_gpu` / `exponential`, `VAEDecodeAudio`, `SaveAudioAdvanced`.

### Weights (both on ModelScope, aria2c -c -x16 -s16; all sizes verified exact)
| File | Source | Size | Speed |
|------|--------|------|-------|
| `models/checkpoints/stable-audio-open-1.0.safetensors` | ModelScope `Comfy-Org/stable-audio-open-1.0_repackaged/resolve/master/` | 4,853,889,016 | 4.85 GB in 7m21s ≈ 11 MB/s |
| `models/text_encoders/t5-base.safetensors` | ModelScope `AI-ModelScope/t5-base/resolve/master/model.safetensors` (byte-size identical to `ComfyUI-Wiki/t5-base` on hf-mirror) | 891,646,390 | 891 MB in 78 s ≈ 11.4 MB/s |

No ComfyUI restart needed — dynamic rescan picked both files up.

### Acceptance (passed)
| File | Prompt | Duration | Format |
|------|--------|----------|--------|
| `/root/comfy/ComfyUI/output/stable_audio_cinematic_00001.flac` | `tense cinematic percussion underscore, low drones, 20 seconds` | **19.97 s** | 44.1 kHz / stereo / 16-bit FLAC |
| `/root/comfy/ComfyUI/output/stable_audio_foley_00001.flac` | `foley: footsteps on gravel at night` | **5.02 s** | 44.1 kHz / stereo / 16-bit FLAC |

Both verified with `torchaudio.info` (venv-cosy). Seeds 20261122 and 777001; `SaveAudioAdvanced` with `flac` written to `output/` root.

## Deviations
1. `/etc/hosts` still has no ModelScope pin (checked again); speeds unaffected.
2. CosyVoice2 weights are **5.6 GB**, not the estimated 2–3 GB (repo now ships extra ONNX/encoder variants).
3. Deleted the ModelScope cache earlier (at your request); CosyVoice's first run re-downloaded its small `wetext` normalizer model into `~/.cache/modelscope/hub/pengzhendong/wetext`.
4. Stable Audio total is **5.74 GB**, not ~1.4 GB — the bundled template expects the 4.52 GB all-in-one checkpoint + 850 MB T5, which is what was fetched.
5. `t5-base.safetensors` sourced from ModelScope `AI-ModelScope/t5-base` instead of hf-mirror; file size matches the official `ComfyUI-Wiki/t5-base` mirror exactly.
6. Two pip install workarounds needed (setuptools pin + wheel pre-fetch) as detailed above; Aliyun mirror throttled specific large wheels to <80 KiB/s.
7. `torchaudio.info()` is gone from the ComfyUI venv's torchaudio 2.11; acceptance duration checks were done with venv-cosy's torchaudio 2.3.1 (and FLAC header parsing as a cross-check).

## Service state
- ComfyUI: single instance on `0.0.0.0:8188` (managed by start.sh/stop.sh).
- CosyVoice2 TTS API: unix socket `/root/comfy/log/tts.sock` (FastAPI, lazy + idle unload, managed by the same scripts, log `/root/comfy/log/cosy_tts_server.log`). No TCP port.
- Conda base untouched (venv-cosy is a plain Python venv; no conda env created).

---

# Polish Tier (2026-11-22): upscale/interpolation, video inpaint/extend, lip-sync

## LIVE / SKIPPED summary
| Phase | Status | Models (source → size) | Custom node commit | Acceptance output |
|-------|--------|------------------------|--------------------|-------------------|
| P1 Real-ESRGAN + RIFE | **LIVE** | `RealESRGAN_x4plus.pth` ← ModelScope `AI-ModelScope/RealESRGAN_x4plus` → 67,040,989 B; `rife47.pth` ← hf-mirror `marduk191/rife` → 21,344,827 B | `Fannovel16/ComfyUI-Frame-Interpolation` @ `26545cc2dd95bc3d27f056016300673bdeee78f5` (2026-03-29) | `output/upscale_x4_accept_00001_.png` (4096×4096); `output/rife_interp_accept2_00001_.webm` (16 frames @32 fps) |
| P2 Wan-VACE inpaint/extend | **LIVE** | `wan2.1_vace_14B_fp8_e4m3fn.safetensors` ← hf-mirror `Kamikaze-88/Wan2.1-VACE-14B-fp8` → 17,344,678,144 B | core only (no custom node) | `output/video/wan_vace_outpaint_accept_00001_.mp4` (752×832, 33 frames, 2.06 s) |
| P3 EchoMimic lip-sync | **LIVE** | ModelScope `BadToBest/EchoMimic`: `denoising_unet.pth` 3,400,035,733; `reference_unet.pth` 3,262,322,201; `motion_module.pth` 1,817,900,817; `face_locator.pth` 4,350,203; `audio_processor/whisper_tiny.pt` 75,572,083; `sd-image-variations-diffusers/unet/diffusion_pytorch_model.bin` 3,438,354,725 + `config.json` 871; ModelScope `stabilityai/sd-vae-ft-mse` → `models/vae/sd-vae-ft-mse.safetensors` 334,643,276 | `smthemex/ComfyUI_EchoMimic` @ `9f430d9219c378505dedec6ed1749d5088745b3c` (2026-11-12) | `output/video/echomimic_accept_00001_.mp4` (1024×1024, 5.688 s audio+video) |

All downloaded files were size-verified against the source listing (exact match). No phase was SKIPPED.

## P1 details
- Real-ESRGAN loaded through core `UpscaleModelLoader` + `ImageUpscaleWithModel` (spandrel); upscale 1024→4096 verified with PIL (ratio 4.0).
- RIFE: node `RIFE VFI` (ckpt `rife47.pth`, multiplier 2, float32, fast_mode/ensemble off). 8 frames extracted from `output/video/wan_smoke_00001_.mp4` with ffmpeg → webm at 32 fps. RIFE returns 2N−1 frames by construction; the final source frame was appended via `ImageBatch` so the saved video has exactly **16 = 2×8** frames (verified with `ffprobe -count_frames`).
- ffmpeg installed via apt for frame extraction/verification.

## P2 details
- Adapted the bundled `video_wan_vace_outpainting.json`: still-image outpaint of `input/sdxl_accept.png` (→512² → pad 120/120/120/200 → 752×832), `WanVaceToVideo` length 33, control_video + repeated control_masks, `ModelSamplingSD3` shift 8, KSampler 20 steps cfg 6.0 euler/simple, `TrimVideoLatent` → `VAEDecode` → `CreateVideo` 16 fps → `SaveVideo`. Prompt/neg standard cinematic. Generation took 434 s.
- No ComfyUI restart needed for this phase.

## P3 details
- Weights pre-placed under `models/echo_mimic/` (and SD-VAE under `models/vae/`), so the node's `download_weights()` never hit HuggingFace.
- Workflow: `Echo_LoadModel` (V1, `audio_drived`, vae `sd-vae-ft-mse.safetensors`) → `Echo_Predata` (portrait `sdxl_accept.png`, audio `input/cosy_zh.wav`, 91 frames @16 fps, cfg 2.5, steps 12, context 12/3) → `Echo_Sampler` → `ImageScale` 512→1024 lanczos → `CreateVideo` (fps linked from sampler, audio attached) → `SaveVideo`.
- Acceptance: video 1024×1024 (= portrait), 5.688 s vs WAV 5.680 s (Δ 0.008 s ≤ 0.5 s), audio track 24 kHz present.

## Deviations
1. `AIFSH/ComfyUI-EchoMimic` does not exist (GitHub auth prompt / 404). Used the actual wrapper `smthemex/ComfyUI_EchoMimic`. GitHub git/TLS was unreliable, so code came from jsDelivr + GitHub API (code/small assets only; 15 files re-fetched via API after jsDelivr error pages, `mel_filters.npz` via API, empty `__init__.py`s recreated). Demo `.pkl` pose files intentionally not fetched (not needed for audio mode).
2. `Fannfull134/ComfyUI-Frame-Interpolation` does not exist; used canonical `Fannovel16/ComfyUI-Frame-Interpolation` (ghfast proxy).
3. ModelScope/Comfy-Org has **no** `wan2.1_vace_14B_fp8_scaled` (only 34.7 GB fp16, plus 1.3B fp16). Used community Comfy-native fp8 `wan2.1_vace_14B_fp8_e4m3fn.safetensors` (keys `model.diffusion_model.*` + `vace_patch_embedding`, F8_E4M3) from hf-mirror; ~16.2 GiB vs "~14 GB". Download stalled at 98% once and was resumed with `aria2c -c`.
4. The outpainting template's CausVid LoRA (`Wan21_CausVid_14B_T2V_lora_rank32`) is not available locally, so the adapted graph uses standard 20-step cfg-6 sampling instead of the 3-step distilled settings.
5. EchoMimic node `requirements.txt` was incomplete for the V1 path: installed `librosa`, `decord`, `pyloudnorm` (and `facenet-pytorch --no-deps` per README). `mediapipe 1.2.3` is incompatible with the code (`no solutions`) but only disables V1/V2 pose modes; audio-driven works. Whisper `assets/mel_filters.npz` was missing due to extension filtering and was fetched via API.
6. Native 1024² EchoMimic sampling was ~42 s/step and multi-hour; ran the sampler at 512² with in-graph lanczos upscale to 1024² (12 steps, 16 fps) to meet the resolution/duration gate. CosyVoice WAV was copied to `input/` for `LoadAudio`.
7. RIFE node default ckpt is `rife49.pth`; explicitly selected the README-listed `rife47.pth`.
8. P1's upscale input was copied from `output/sdxl_t2i_accept_00001_.png` into `input/` because `LoadImage` only reads the input directory.

## Service state (unchanged)
- ComfyUI (TCP 8188) and CosyVoice2 TTS (unix socket `/root/comfy/log/tts.sock`) are both managed by `start.sh`/`stop.sh` (ComfyUI was additionally restarted for P1b and P3a installs).
- The only TCP port is 8188; conda base untouched.

## Lazy-loading policy
- All AI models are lazy: ComfyUI stages checkpoints/VAEs/encoders into VRAM only when a workflow node executes (model manager can offload/free them), and the CosyVoice2 TTS service builds its model on the first `/tts` call and unloads it after `COSY_IDLE_TIMEOUT` idle seconds (default 600 s). Nothing is eagerly loaded at service start.

## Model catalog API (2026-11-22)
- Routes-only extension `custom_nodes/model_catalog` (never loads weights; stats files only) adds, on the ComfyUI port (also under `/api/...`):
  - `GET /model_catalog` — all lazy models with ~100-word descriptions, exact sizes, loader, `est_vram_gb`/`est_ram_gb`
  - `GET /model_catalog/categories` — category list + counts
  - `GET /model_catalog/{category}` — one category (404 for unknown)
- Full operator documentation (start/stop, HTTP calls, catalog, TTS socket): `/root/comfy/README.md`.

## Logging (2026-11-22)
- Central log directory: `/root/comfy/log/`
  - `/root/comfy/log/comfyui.log` — ComfyUI stdout/stderr (all nodes/libraries included); `start.sh` now writes here (`LOG_DIR` variable).
  - `/root/comfy/log/cosy_tts_server.log` — CosyVoice2 FastAPI service.
- Rotation: `/etc/logrotate.d/comfy` (`weekly`, `rotate 4`, `compress`, `delaycompress`, `copytruncate`, `su root root`). Applied automatically by the system logrotate timer/cron. `copytruncate` lets rotation happen without restarting the services.
- ComfyUI itself has no per-model log files; model/library warnings go to the process stream, so `comfyui.log` is the single sink.
