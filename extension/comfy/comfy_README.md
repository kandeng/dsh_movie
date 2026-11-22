# Movie Pipeline — ComfyUI Stack

ComfyUI 0.46.0 with **lazy-loaded** AI models, a prompt-driven HTTP API, a model catalog API,
and a lazily-loaded CosyVoice2 narration service. This README covers startup/shutdown, the HTTP
API, and the model catalog.

## Architecture at a glance

| Service | Transport | Lifecycle |
|---|---|---|
| ComfyUI (`/root/comfy/ComfyUI`) | TCP `8188` | `start.sh` / `stop.sh` |
| CosyVoice2 TTS (`/root/comfy/cosyvoice_tts_server.py`) | **Unix socket** `/root/comfy/log/tts.sock` (no TCP port) | same scripts |
| Models | none until used | mapped/loaded on first workflow node execution |

**Lazy loading** is the core rule: nothing is loaded at startup. ComfyUI maps weights from disk
only when a node that needs them executes; CosyVoice2 builds its model on the first `/tts`
request and unloads it after `COSY_IDLE_TIMEOUT` seconds idle (default 600). After a fresh
start, GPUs sit at ~331 MB used and `nvidia-smi` shows no model memory.

## Start / stop

```bash
/root/comfy/start.sh    # ComfyUI + TTS, waits until both are ready, idempotent
/root/comfy/stop.sh     # SIGTERM both, SIGKILL after 15 s, removes stale TTS socket
```

- `start.sh` starts both services (skipping any already running) and waits up to 180 s for
  `GET http://127.0.0.1:8188/system_stats` and `GET /health` on the TTS socket.
- `stop.sh` stops **ComfyUI and the TTS service in one shot**. Because every model lives inside
  one of those two processes, stopping them frees all model VRAM at once.
- Logs: `/root/comfy/log/comfyui.log`, `/root/comfy/log/cosy_tts_server.log`
  (rotated weekly, 4 copies, compressed — `/etc/logrotate.d/comfy`).

Verify:

```bash
curl -s http://127.0.0.1:8188/system_stats | python3 -m json.tool | head
curl -s --unix-socket /root/comfy/log/tts.sock http://localhost/health
```

## HTTP API (ComfyUI, port 8188)

Every endpoint is also available under the `/api/...` prefix (e.g. `/api/prompt`).

### System & introspection

| Method | Path | Purpose |
|---|---|---|
| GET | `/system_stats` | version, devices, VRAM |
| GET | `/object_info` | all node classes and their input schemas |
| GET | `/queue` | current queue |
| POST | `/interrupt` | cancel the running prompt |
| GET | `/model_catalog` | **all lazy models with descriptions (see below)** |
| GET | `/model_catalog/categories` | category list + counts |
| GET | `/model_catalog/{category}` | models in one category |

### The model catalog (custom endpoint)

Implemented by `/root/comfy/ComfyUI/custom_nodes/model_catalog/__init__.py` (routes-only
extension: it never loads weights, it only stats files on disk).

```bash
curl -s http://127.0.0.1:8188/model_catalog | python3 -m json.tool | head -60
curl -s http://127.0.0.1:8188/model_catalog/diffusion_models
curl -s http://127.0.0.1:8188/model_catalog/categories
```

Each entry contains:

```json
{
  "id": "checkpoints/sd_xl_base_1.0.safetensors",
  "category": "checkpoints",
  "filename": "sd_xl_base_1.0.safetensors",
  "path": "/root/comfy/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors",
  "size_bytes": 6938078334,
  "size_human": "6.46 GB",
  "lazy_loaded": true,
  "purpose": "SDXL base text-to-image checkpoint (Stability AI)",
  "loader": "CheckpointLoaderSimple",
  "est_vram_gb": 9,
  "est_ram_gb": 9,
  "description": "…~100-word description, purpose, behaviour, memory…"
}
```

`est_vram_gb` / `est_ram_gb` are practical estimates for this stack (fp8/fp16, typical
resolution); actual use depends on resolution, steps, batch size and ComfyUI's VRAM policy.
`size_bytes` is exact.

### Run a workflow

1. Build an **API-format** workflow (the JSON with `{"prompt": {"<node-id>": {...}}}`; the
   UI-format files with `nodes`/`links` are not accepted). Get node schemas from `/object_info`.
2. Submit it:

```bash
curl -s -X POST http://127.0.0.1:8188/prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt": {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cinematic portrait", "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry, low quality", "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "5": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0],
              "latent_image": ["4", 0], "seed": 42, "steps": 20, "cfg": 7.0,
              "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": "my_job"}}
      }}'
# → {"prompt_id": "…", "number": 0, "node_errors": {}}
```

3. Poll the result and fetch the file:

```bash
PID=<prompt_id>
curl -s http://127.0.0.1:8188/history/$PID | python3 -m json.tool
# outputs → {"images":[{"filename":"my_job_00001_.png","subfolder":"","type":"output"}]}
curl -s -o out.png "http://127.0.0.1:8188/view?filename=my_job_00001_.png&subfolder=&type=output"
```

- Audio/video workflows work the same way; `SaveAudio`/`SaveVideo` outputs appear under
  `/view` too (same `filename/subfolder/type` query).
- **Upload an input image** (for LoadImage): `curl -F "image=@portrait.png" -F "overwrite=true" http://127.0.0.1:8188/upload/image`
- **Progress**: connect to `ws://127.0.0.1:8188/ws?clientId=<id>` and pass the same
  `client_id` in `/prompt`; events include `execution_start`, `executing`, `progress`,
  `execution_cached`, `execution_success/error`.
- Models load on the first node that needs them; the first run of a large model (e.g.
  Qwen-Image, Wan) therefore includes the load time, later runs reuse it until ComfyUI
  offloads it.

## Engine cookbook — copy-paste `/prompt` payloads

All snippets below POST **API-format** JSON directly and return `{"prompt_id": "..."}`. They are
the exact graphs used for the acceptance runs in this stack. Common pattern:

```bash
PID=$(curl -s -X POST http://127.0.0.1:8188/prompt -H 'Content-Type: application/json' -d @- <<'JSON' | python3 -c 'import json,sys; print(json.load(sys.stdin)["prompt_id"])'
{ "prompt": { ... } }
JSON
)
curl -s http://127.0.0.1:8188/history/$PID | python3 -m json.tool
# files are under ComfyUI/output/ and downloadable via
#   /view?filename=<name>&subfolder=<sub>&type=output
```

Input files must be in `/root/comfy/ComfyUI/input/`. Images can be uploaded with
`curl -F "image=@file.png" -F "overwrite=true" http://127.0.0.1:8188/upload/image`;
audio/video files are easiest copied there (e.g. `cp narration.wav /root/comfy/ComfyUI/input/`).
First execution of each engine includes the lazy model-load time.

### 1) SDXL — 1024x1024 text-to-image

```bash
curl -s -X POST http://127.0.0.1:8188/prompt -H 'Content-Type: application/json' -d '{
 "prompt": {
  "1": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"sd_xl_base_1.0.safetensors"}},
  "2": {"class_type":"CLIPTextEncode","inputs":{"text":"a cinematic portrait of a woman with freckles, soft window light, 85mm photo","clip":["1",1]}},
  "3": {"class_type":"CLIPTextEncode","inputs":{"text":"blurry, low quality, deformed, watermark","clip":["1",1]}},
  "4": {"class_type":"EmptyLatentImage","inputs":{"width":1024,"height":1024,"batch_size":1}},
  "5": {"class_type":"KSampler","inputs":{"model":["1",0],"positive":["2",0],"negative":["3",0],"latent_image":["4",0],
         "seed":123456789,"steps":20,"cfg":7.0,"sampler_name":"euler","scheduler":"normal","denoise":1.0}},
  "6": {"class_type":"VAEDecode","inputs":{"samples":["5",0],"vae":["1",2]}},
  "7": {"class_type":"SaveImage","inputs":{"images":["6",0],"filename_prefix":"sdxl_t2i"}}
 }}'
```

Output: `output/sdxl_t2i_00001_.png`. ≈11 s warm; ~9 GB VRAM.

### 2) Qwen-Image — 1328x1328, strong Chinese typography

```bash
curl -s -X POST http://127.0.0.1:8188/prompt -H 'Content-Type: application/json' -d '{
 "prompt": {
  "1": {"class_type":"UNETLoader","inputs":{"unet_name":"qwen_image_fp8_e4m3fn.safetensors","weight_dtype":"default"}},
  "2": {"class_type":"ModelSamplingAuraFlow","inputs":{"model":["1",0],"shift":3.1}},
  "3": {"class_type":"CLIPLoader","inputs":{"clip_name":"qwen_2.5_vl_7b_fp8_scaled.safetensors","type":"qwen_image","device":"default"}},
  "4": {"class_type":"VAELoader","inputs":{"vae_name":"qwen_image_vae.safetensors"}},
  "5": {"class_type":"CLIPTextEncode","inputs":{"text":"一张电影海报，标题文字：山海之间，导演：邓侃。电影海报构图，山水意境，汉字标题清晰醒目，专业排版，高质量","clip":["3",0]}},
  "6": {"class_type":"CLIPTextEncode","inputs":{"text":"低质量，模糊，文字错误，变形","clip":["3",0]}},
  "7": {"class_type":"EmptySD3LatentImage","inputs":{"width":1328,"height":1328,"batch_size":1}},
  "8": {"class_type":"KSampler","inputs":{"model":["2",0],"positive":["5",0],"negative":["6",0],"latent_image":["7",0],
         "seed":424242,"steps":20,"cfg":2.5,"sampler_name":"euler","scheduler":"simple","denoise":1.0}},
  "9": {"class_type":"VAEDecode","inputs":{"samples":["8",0],"vae":["4",0]}},
  "10":{"class_type":"SaveImage","inputs":{"images":["9",0],"filename_prefix":"qwen_image"}}
 }}'
```

Output: `output/qwen_image_00001_.png`. ≈22 GB VRAM when resident.

### 3) Wan VACE — 33-frame video outpainting

Upload the source first: `curl -F "image=@source.png" -F "overwrite=true" http://127.0.0.1:8188/upload/image`
(This example pads a 512x512 portrait to 752x832.)

```bash
curl -s -X POST http://127.0.0.1:8188/prompt -H 'Content-Type: application/json' -d '{
 "prompt": {
  "0": {"class_type":"ImageScale","inputs":{"image":["1",0],"upscale_method":"lanczos","width":512,"height":512,"crop":"disabled"}},
  "1": {"class_type":"LoadImage","inputs":{"image":"source.png"}},
  "2": {"class_type":"ImagePadForOutpaint","inputs":{"image":["0",0],"left":120,"top":120,"right":120,"bottom":200,"feathering":40}},
  "3": {"class_type":"RepeatImageBatch","inputs":{"image":["2",0],"amount":33}},
  "4": {"class_type":"MaskToImage","inputs":{"mask":["2",1]}},
  "5": {"class_type":"RepeatImageBatch","inputs":{"image":["4",0],"amount":33}},
  "6": {"class_type":"ImageToMask","inputs":{"image":["5",0],"channel":"red"}},
  "7": {"class_type":"CLIPLoader","inputs":{"clip_name":"umt5_xxl_fp8_e4m3fn_scaled.safetensors","type":"wan","device":"default"}},
  "8": {"class_type":"CLIPTextEncode","inputs":{"text":"A cinematic portrait of a woman in a softly lit room, extended scene with natural background, film still","clip":["7",0]}},
  "9": {"class_type":"CLIPTextEncode","inputs":{"text":"bad quality, blurry, distorted, watermark","clip":["7",0]}},
  "10":{"class_type":"UNETLoader","inputs":{"unet_name":"wan2.1_vace_14B_fp8_e4m3fn.safetensors","weight_dtype":"default"}},
  "11":{"class_type":"ModelSamplingSD3","inputs":{"model":["10",0],"shift":8.0}},
  "12":{"class_type":"VAELoader","inputs":{"vae_name":"wan_2.1_vae.safetensors"}},
  "13":{"class_type":"WanVaceToVideo","inputs":{"positive":["8",0],"negative":["9",0],"vae":["12",0],
         "width":752,"height":832,"length":33,"batch_size":1,"strength":1.0,
         "control_video":["3",0],"control_masks":["6",0]}},
  "14":{"class_type":"KSampler","inputs":{"model":["11",0],"positive":["13",0],"negative":["13",1],"latent_image":["13",2],
         "seed":20261122,"steps":20,"cfg":6.0,"sampler_name":"euler","scheduler":"simple","denoise":1.0}},
  "15":{"class_type":"TrimVideoLatent","inputs":{"samples":["14",0],"trim_amount":["13",3]}},
  "16":{"class_type":"VAEDecode","inputs":{"samples":["15",0],"vae":["12",0]}},
  "17":{"class_type":"CreateVideo","inputs":{"images":["16",0],"fps":16.0}},
  "18":{"class_type":"SaveVideo","inputs":{"video":["17",0],"filename_prefix":"video/vace_outpaint","format":"auto"}}
 }}'
```

Output: `output/video/vace_outpaint_00001_.mp4`. ≈7 min on an H20 at these settings; ~24 GB VRAM.

### 4) Stable Audio Open — 20 s cinematic underscore

```bash
curl -s -X POST http://127.0.0.1:8188/prompt -H 'Content-Type: application/json' -d '{
 "prompt": {
  "1": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"stable-audio-open-1.0.safetensors"}},
  "2": {"class_type":"CLIPLoader","inputs":{"clip_name":"t5-base.safetensors","type":"stable_audio","device":"default"}},
  "3": {"class_type":"CLIPTextEncode","inputs":{"text":"tense cinematic percussion underscore, low drones, 20 seconds","clip":["2",0]}},
  "4": {"class_type":"CLIPTextEncode","inputs":{"text":"","clip":["2",0]}},
  "5": {"class_type":"EmptyLatentAudio","inputs":{"seconds":20.0,"batch_size":1}},
  "6": {"class_type":"KSampler","inputs":{"model":["1",0],"positive":["3",0],"negative":["4",0],"latent_image":["5",0],
         "seed":20261122,"steps":50,"cfg":4.98,"sampler_name":"dpmpp_3m_sde_gpu","scheduler":"exponential","denoise":1.0}},
  "7": {"class_type":"VAEDecodeAudio","inputs":{"samples":["6",0],"vae":["1",2]}},
  "8": {"class_type":"SaveAudioAdvanced","inputs":{"audio":["7",0],"filename_prefix":"stable_audio_cinematic","format":"flac"}}
 }}'
```

Output: `output/stable_audio_cinematic_00001.flac` (44.1 kHz stereo). For foley use
`"foley: footsteps on gravel at night"` with `seconds: 5.0`.

### 5) EchoMimic v1 — lip-sync portrait + narration

Copy inputs first:
```bash
cp /path/portrait.png narration.wav /root/comfy/ComfyUI/input/
# length = round(audio_duration_seconds * fps); 91 frames ≈ 5.68 s at 16 fps
```

```bash
curl -s -X POST http://127.0.0.1:8188/prompt -H 'Content-Type: application/json' -d '{
 "prompt": {
  "1": {"class_type":"Echo_LoadModel","inputs":{"vae":"sd-vae-ft-mse.safetensors","lora":"None","denoising":true,
        "infer_mode":"audio_drived","lowvram":false,"teacache_offload":true,"block_offload":true,"use_mmgp":"None","version":"V1"}},
  "2": {"class_type":"LoadImage","inputs":{"image":"portrait.png"}},
  "3": {"class_type":"LoadAudio","inputs":{"audio":"narration.wav"}},
  "4": {"class_type":"Echo_Predata","inputs":{"info":["1",1],"image":["2",0],"audio":["3",0],
        "prompt":"A woman speaking calmly to camera, natural subtle head and facial movements.",
        "negative_prompt":"bad quality, distorted face, extra limbs, blurry",
        "pose_dir":"pose_01","width":512,"height":512,"fps":16.0,
        "facemask_ratio":0.1,"facecrop_ratio":0.8,"length":91,
        "partial_video_length":33,"draw_mouse":false,"motion_sync_":false}},
  "5": {"class_type":"Echo_Sampler","inputs":{"model":["1",0],"emb":["4",0],"seed":20261122,"cfg":2.5,"steps":12,
        "sample_rate":16000,"context_frames":12,"context_overlap":3,"save_video":false}},
  "6": {"class_type":"ImageScale","inputs":{"image":["5",0],"upscale_method":"lanczos","width":1024,"height":1024,"crop":"disabled"}},
  "7": {"class_type":"CreateVideo","inputs":{"images":["6",0],"fps":["5",1],"audio":["3",0]}},
  "8": {"class_type":"SaveVideo","inputs":{"video":["7",0],"filename_prefix":"video/echomimic","format":"auto"}}
 }}'
```

Output: `output/video/echomimic_00001_.mp4` (1024x1024, duration matches the WAV). Generating at
512 and upscaling keeps this ~20 min instead of hours; raise `width/height` only if needed.

### 6) Real-ESRGAN 4x upscale

```bash
curl -s -X POST http://127.0.0.1:8188/prompt -H 'Content-Type: application/json' -d '{
 "prompt": {
  "1": {"class_type":"LoadImage","inputs":{"image":"sdxl_t2i_00001_.png"}},
  "2": {"class_type":"UpscaleModelLoader","inputs":{"model_name":"RealESRGAN_x4plus.pth"}},
  "3": {"class_type":"ImageUpscaleWithModel","inputs":{"upscale_model":["2",0],"image":["1",0]}},
  "4": {"class_type":"SaveImage","inputs":{"images":["3",0],"filename_prefix":"upscale_x4"}}
 }}'
```

(LoadImage reads `input/`; copy the source there first.) Output: `output/upscale_x4_00001_.png`.

### 7) RIFE interpolation x2 (8 frames → 16, 32 fps)

Extract frames first:
```bash
mkdir -p /root/comfy/ComfyUI/input/frames
ffmpeg -v error -i /root/comfy/ComfyUI/output/video/vace_outpaint_00001_.mp4 \
  -vf "select=not(mod(n\,6))" -vsync vfr -frames:v 8 /root/comfy/ComfyUI/input/frames/frame_%02d.png
```

```bash
curl -s -X POST http://127.0.0.1:8188/prompt -H 'Content-Type: application/json' -d '{
 "prompt": {
  "1": {"class_type":"LoadImage","inputs":{"image":"frames/frame_01.png"}},
  "2": {"class_type":"LoadImage","inputs":{"image":"frames/frame_02.png"}},
  "3": {"class_type":"LoadImage","inputs":{"image":"frames/frame_03.png"}},
  "4": {"class_type":"LoadImage","inputs":{"image":"frames/frame_04.png"}},
  "5": {"class_type":"LoadImage","inputs":{"image":"frames/frame_05.png"}},
  "6": {"class_type":"LoadImage","inputs":{"image":"frames/frame_06.png"}},
  "7": {"class_type":"LoadImage","inputs":{"image":"frames/frame_07.png"}},
  "8": {"class_type":"LoadImage","inputs":{"image":"frames/frame_08.png"}},
  "22":{"class_type":"ImageBatch","inputs":{"image1":["1",0],"image2":["2",0]}},
  "23":{"class_type":"ImageBatch","inputs":{"image1":["22",0],"image2":["3",0]}},
  "24":{"class_type":"ImageBatch","inputs":{"image1":["23",0],"image2":["4",0]}},
  "25":{"class_type":"ImageBatch","inputs":{"image1":["24",0],"image2":["5",0]}},
  "26":{"class_type":"ImageBatch","inputs":{"image1":["25",0],"image2":["6",0]}},
  "27":{"class_type":"ImageBatch","inputs":{"image1":["26",0],"image2":["7",0]}},
  "28":{"class_type":"ImageBatch","inputs":{"image1":["27",0],"image2":["8",0]}},
  "30":{"class_type":"RIFE VFI","inputs":{"ckpt_name":"rife47.pth","frames":["28",0],"clear_cache_after_n_frames":10,
        "multiplier":2,"fast_mode":false,"ensemble":false,"scale_factor":1.0,"dtype":"float32",
        "torch_compile":false,"batch_size":1}},
  "32":{"class_type":"ImageBatch","inputs":{"image1":["30",0],"image2":["8",0]}},
  "31":{"class_type":"SaveWEBM","inputs":{"images":["32",0],"filename_prefix":"rife_interp","codec":"vp9","fps":32.0,"crf":20.0}}
 }}'
```

RIFE VFI returns 2N−1 frames; node 32 appends the final source frame so the output is exactly
16 frames (8 × 2). Output: `output/rife_interp_00001_.webm` at 32 fps.

## TTS API (CosyVoice2, Unix socket — no TCP port)

```bash
SOCK=/root/comfy/log/tts.sock

curl -s --unix-socket $SOCK http://localhost/health
# {"status":"ok","model_loaded":false,...}

curl -s --unix-socket $SOCK -X POST http://localhost/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"深夜的机房里，八块显卡同时亮起绿灯，像一片安静的森林。","speaker_id":"female_zh"}' \
  -o narration.wav
```

- First request loads the model (~90 s observed); subsequent requests are warm (~2–4 s).
- `model_loaded` in `/health` tells you whether it is resident; after `COSY_IDLE_TIMEOUT`
  seconds idle it unloads automatically and frees its VRAM.
- `speaker_id`: `female_zh` (zero-shot with bundled prompt), `female_zh_alt` (cross-lingual).
- Output is 24 kHz mono WAV.

## Model inventory (24 entries, ~107 GB on disk)

Sizes are on-disk bytes; VRAM figures are estimates from the catalog endpoint.

| Category | Model | Size | Purpose | ≈VRAM |
|---|---|---|---|---|
| checkpoints | `sd_xl_base_1.0.safetensors` | 6.46 GB | SDXL text-to-image + InstantID/IPAdapter backbone | 9 GB |
| checkpoints | `stable-audio-open-1.0.safetensors` | 4.52 GB | SFX / foley / BGM (44.1 kHz stereo) | 7 GB |
| diffusion_models | `qwen_image_fp8_e4m3fn.safetensors` | 19.03 GB | Qwen-Image 20B T2I, Chinese/English typography | 22 GB |
| diffusion_models | `wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` | 13.31 GB | Wan 2.2 T2V stage 1 | 20 GB |
| diffusion_models | `wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` | 13.31 GB | Wan 2.2 T2V stage 2 | 20 GB |
| diffusion_models | `wan2.1_vace_14B_fp8_e4m3fn.safetensors` | 16.15 GB | VACE inpaint/outpaint/extend | 24 GB |
| text_encoders | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | 8.74 GB | Qwen-Image prompt encoder | 11 GB |
| text_encoders | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6.27 GB | Wan video prompt encoder | 8 GB |
| text_encoders | `t5-base.safetensors` | 0.83 GB | Stable Audio prompt encoder | 2 GB |
| vae | `qwen_image_vae.safetensors` | 0.24 GB | Qwen-Image decode | 1 GB |
| vae | `wan_2.1_vae.safetensors` | 0.24 GB | Wan video decode/encode | 2 GB |
| vae | `sd-vae-ft-mse.safetensors` | 0.31 GB | SD1.5 VAE for EchoMimic | 1 GB |
| clip_vision | `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | 2.35 GB | IPAdapter/InstantID image encoder | 3 GB |
| controlnet | `control_instantid_sdxl.safetensors` | 2.33 GB | InstantID keypoint ControlNet | 3 GB |
| instantid | `ip-adapter.bin` | 1.57 GB | InstantID identity adapter | 2 GB |
| upscale_models | `RealESRGAN_x4plus.pth` | 64 MB | 4× upscaling | 3 GB |
| echo_mimic | `denoising_unet.pth` | 3.17 GB | Lip-sync denoising UNet | 6 GB |
| echo_mimic | `reference_unet.pth` | 3.04 GB | Lip-sync appearance reference | 4 GB |
| echo_mimic | `motion_module.pth` | 1.69 GB | Temporal motion module | 2 GB |
| echo_mimic | `unet/diffusion_pytorch_model.bin` | 3.20 GB | SD-image-variations base UNet | 4 GB |
| echo_mimic | `audio_processor/whisper_tiny.pt` | 70 MB | Audio feature extractor | 1 GB |
| echo_mimic | `face_locator.pth` | 4 MB | Face mask guidance | <1 GB |
| insightface | `antelopev2` pack (5 ONNX) | 427 MB | Face detect/align/embed | 1 GB |
| frame_interpolation | `rife47.pth` (custom node ckpts) | 20 MB | RIFE 4.7 frame interpolation | 1 GB |

Plus the external `CosyVoice2-0.5B` narration model (`/root/comfy/CosyVoice/pretrained_models/`,
~5.2 GB; ~4.6 GB VRAM while loaded; lazy + idle-unload over the Unix socket).
Per-model ~100-word descriptions and exact bytes come from `GET /model_catalog`.

## Remote access (Tailscale)

Facts about this host: it sits behind the enterprise firewall on a **static private LAN address
`172.16.80.31/24`** (`bridge0`, NetworkManager `ipv4.method manual`); outbound traffic is NAT'd
(no usable static public IP), and there is no evidence of inbound port-forwarding. ComfyUI
listens on `0.0.0.0:8188`; the TTS service is a **local Unix socket only** and is never remotely
reachable. A ZeroTier client is also installed and online (`192.168.196.105/24`) as an
alternative overlay.

Tailscale (1.98.8) is installed and `tailscaled` is enabled, but the daemon may be stopped and
a previous enrollment (state from 2025) may have expired. First-time setup prints a browser
login URL, so run it interactively.

### 1) Start Tailscale on the H20 server

```bash
sudo systemctl enable --now tailscaled
sudo tailscale status            # shows whether this node is already logged in
tailscale ip -4                  # e.g. 100.x.y.z (only after login)
```

If it reports "Logged out" / "NeedsLogin":

```bash
sudo tailscale up                # prints https://login.tailscale.com/... — open it and authenticate
# optional: sudo tailscale up --ssh     (enables Tailscale SSH)
```

Notes:
- If your organization uses a tagged/ACL'd tailnet, an admin may need to approve the node or
  you may need `--advertise-tags=tag:<name>`.
- Raw WireGuard connectivity uses outbound UDP 41641; if that is blocked, Tailscale falls back
  to DERP relays over TCP 443, so no inbound firewall openings are required.

### 2) Join the same tailnet from the outside computer

Ubuntu:
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                # log in with the same account/org as the H20 server
tailscale status                 # the H20 node should be listed
```

(Windows/macOS: install the Tailscale app and log in with the same account.)

Then, from the outside machine:

```bash
ping <h20-tailnet-ip>                                    # 100.x.y.z, or the MagicDNS name
curl http://<h20-tailnet-ip>:8188/system_stats
curl http://<h20-tailnet-ip>:8188/model_catalog
```

Open the UI in a browser at `http://<h20-tailnet-ip>:8188` (or its MagicDNS name, e.g.
`http://<hostname>:8188`). No change to ComfyUI is needed because it already binds `0.0.0.0`.

### 3) Lock down who can reach the API

The ComfyUI API has **no authentication**, so restrict port 8188 to the tailnet:

```bash
sudo ufw allow in on tailscale0 to any port 8188 proto tcp
sudo ufw deny 8188/tcp
sudo ufw enable
```

(UFW is currently inactive on this host.) Optionally expose only a tailnet-only HTTPS proxy
with identity attached:

```bash
sudo tailscale serve --bg https / http://127.0.0.1:8188
```

Do **not** enable Tailscale Funnel (public internet exposure) unless you add authentication in
front. The TTS socket stays local to the machine; access it through a shell on the host or an
SSH forward, e.g. `ssh -L /tmp/tts.sock:/root/comfy/log/tts.sock user@host`.

### 4) Fallbacks

- **SSH tunnel** (`sshd` listens on `0.0.0.0:22`): `ssh -L 8188:127.0.0.1:8188 <user>@<host>`,
  then use `http://127.0.0.1:8188` locally — nothing new is exposed.
- **ZeroTier** (already online): if the outside computer is authorized on the same ZeroTier
  network, reach the API directly at `http://192.168.196.105:8188` without Tailscale.

### Remote-access troubleshooting

```bash
tailscale status                 # peers + connection state
tailscale netcheck               # NAT type, DERP latency, UDP reachability
tailscale ping <peer-name>       # path: direct vs relay ("via DERP")
systemctl status tailscaled      # daemon state
```

If `tailscale ping` works but `curl` fails, check `ufw status` (rule above) and confirm ComfyUI
is listening: `ss -ltn | grep 8188`.

## Troubleshooting

- **A model didn't appear in the catalog**: check `/root/comfy/ComfyUI/models/<category>/`,
  ensure the file is >1 KB and not named `put_*`/`*.aria2`.
- **First run is slow**: expected — the model is loading. Watch
  `/root/comfy/log/comfyui.log` for staging/loading lines.
- **TTS returns 404/connection refused**: service not running or stale socket →
  run `/root/comfy/start.sh` (or `stop.sh` then `start.sh`).
- **ComfyUI shows 0 free VRAM**: stop the stack (`stop.sh`) to release everything, then start.
- Logs: `/root/comfy/log/`, rotated by `/etc/logrotate.d/comfy`.
