# DEPLOY — bring the movie ComfyUI stack up on a fresh GPU box

Ordered, copy-paste bring-up. Every path derives from one knob, `COMFY_ROOT`
(default `/root/comfy`, the reference layout). The stack is the **8-GPU fleet**:
`comfy_start.sh` brings the GPU0 main engine (`:8188`) + the CosyVoice2 TTS
sidecar (unix socket), then delegates to `comfy_start_multi.sh` for the fleet
instances (`:8189-:8195`, one per GPU); the whole thing is supervised by the
oneshot unit `comfy-multi.service`.

> **Single-vs-fleet note.** `INSTALL.md` is a chronological *provenance log*;
> its early "Usage / Service state" sections describe the original
> **single-instance** `start.sh`/`stop.sh` (port 8188 only) and are **historical**.
> The current, supported runtime is the fleet described here and in `README.md`.
> Where the two disagree, this file wins.

## 0. Prereqs

- Ubuntu 22.04, NVIDIA driver with `nvidia-smi` working; note the GPU count `N`.
- Python 3.11 via deadsnakes (Ubuntu 22.04's `python3.11` is `3.11.0~rc1` and
  lacks `sys.get_int_max_str_digits`, which PyTorch needs):
  `add-apt-repository ppa:deadsnakes/ppa && apt-get update && apt-get install -y python3.11 python3.11-venv`
- `apt-get install -y aria2 ffmpeg curl git`
- **Disk:** >= ~200 GB free on the volume holding `COMFY_ROOT` (models ~107 GB +
  `venv` + `venv-cosy` ~12 GB + outputs). Check with `df -h` first — the
  reference host once had `/` at 5.7 GB and `/data` 100% full (INSTALL.md).

## 1. Layout + ComfyUI venv

```bash
export COMFY_ROOT=/root/comfy          # change once; everything below follows
mkdir -p "$COMFY_ROOT"/{log,script}
python3.11 -m venv "$COMFY_ROOT/venv"
git clone https://github.com/comfyanonymous/ComfyUI "$COMFY_ROOT/ComfyUI"
cd "$COMFY_ROOT/ComfyUI" && git checkout f99de883d     # reference = 0.46.0
"$COMFY_ROOT/venv/bin/pip" install -r requirements.txt
"$COMFY_ROOT/venv/bin/pip" install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126
# sanity: version + CUDA visible
"$COMFY_ROOT/venv/bin/python" -c "import torch;print(torch.__version__,torch.cuda.is_available(),torch.cuda.device_count())"
```

## 2. Custom nodes

In-repo nodes (routes-only; ship with this repository):

```bash
REPO=/path/to/dsh_movie                # your clone of this repo
cp -r "$REPO/extension/comfy/custom_nodes/model_catalog" "$COMFY_ROOT/ComfyUI/custom_nodes/"
cp -r "$REPO/extension/comfy/custom_nodes/tts_route"     "$COMFY_ROOT/ComfyUI/custom_nodes/"
```

Third-party nodes at the pinned commits (provenance: INSTALL.md):

| Repo | Commit |
|---|---|
| `cubiq/ComfyUI_IPAdapter_plus` | `a0f451a5113cf9becb0847b92884cb10cbdec0ef` |
| `cubiq/ComfyUI_InstantID` | `72495e806bc2ab9c41581e15ccaa1bcf83c477e8` |
| `Fannovel16/ComfyUI-Frame-Interpolation` | `26545cc2dd95bc3d27f056016300673bdeee78f5` |
| `smthemex/ComfyUI_EchoMimic` | `9f430d9219c378505dedec6ed1749d5088745b3c` |

```bash
cd "$COMFY_ROOT/ComfyUI/custom_nodes"
# clone each at its pinned commit, then install its pip deps into $COMFY_ROOT/venv, e.g.:
#   git clone <repo> && (cd <dir> && git checkout <commit>)
# Known deps: insightface==2.1, onnxruntime==1.32.0 then --force-reinstall
# onnxruntime-gpu==1.32.0 (last), opencv-python, scikit-image; EchoMimic V1 also
# needs librosa, decord, pyloudnorm, facenet-pytorch(--no-deps).
```

## 3. Models (bill-of-materials)

The manifest `models.manifest` (TSV: `dest<TAB>size_bytes<TAB>url`, `dest`
relative to `COMFY_ROOT`) ships in this directory. Download resume-safe and
size-verified:

```bash
cd "$(dirname "$0")" 2>/dev/null || cd /path/to/dsh_movie/deployment/H20/comfy
COMFY_ROOT="$COMFY_ROOT" ./download_models.sh            # ~107 GB; long-running
COMFY_ROOT="$COMFY_ROOT" ./download_models.sh --check-only   # audit afterwards
```

If a mirror has moved, fix that row's `url` and re-run; `size_bytes` guards you
against truncated/wrong files. Rows with `url = -` must be placed by hand.

## 4. CosyVoice2 TTS sidecar (venv-cosy)

```bash
python3.11 -m venv "$COMFY_ROOT/venv-cosy"
git clone https://github.com/FunAudioLLM/CosyVoice "$COMFY_ROOT/CosyVoice"
cd "$COMFY_ROOT/CosyVoice" && git checkout 074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc
git submodule update --init --depth 1        # Matcha-TTS is REQUIRED
"$COMFY_ROOT/venv-cosy/bin/pip" install -r requirements.txt
# known workarounds (INSTALL.md): pip install "setuptools<80" wheel, then
# pip install --no-build-isolation --no-deps openai-whisper==20231117
```

Install the service script and its weights (weights are in the manifest under
`CosyVoice/pretrained_models/...`):

```bash
cp /path/to/dsh_movie/deployment/H20/comfy/cosyvoice_tts_server.py "$COMFY_ROOT/script/"
COMFY_ROOT="$COMFY_ROOT" ./download_models.sh   # fetches CosyVoice2-0.5B too
```

## 5. Launchers + systemd unit

```bash
SRC=/path/to/dsh_movie/deployment/H20/comfy
install -m 0755 "$SRC/comfy_start.sh" "$SRC/comfy_start_multi.sh" "$SRC/comfy_stop_multi.sh" "$COMFY_ROOT/"
# unit: if COMFY_ROOT != /root/comfy, rewrite ExecStart/ExecStop/WorkingDirectory
# and the Environment= line, then:
sed "s#/root/comfy#$COMFY_ROOT#g" "$SRC/comfy-multi.service" > /etc/systemd/system/comfy-multi.service
systemctl daemon-reload && systemctl enable --now comfy-multi
```

`comfy_start.sh` is idempotent and waits for `:8188/system_stats` + the TTS
socket `/health`; `comfy_start_multi.sh` pins `CUDA_VISIBLE_DEVICES` per
instance and gives each its own `output-N`/`user-N`. Tune the fleet with
`COMFY_GPU_IDS` (default `1 2 3 4 5 6 7`) and `COMFY_BOOT_TIMEOUT`.

## 6. Remote access (ZeroTier)

```bash
curl -s https://install.zerotier.com | sudo bash
sudo zerotier-cli join <16-hex-nwid>      # then authorize the node in ZeroTier Central
sudo zerotier-cli listnetworks            # wait for OK + a managed IP
ip -brief addr | grep -i zt
```

The ComfyUI API has **no authentication**; exposure is limited to authorized
overlay members. Record the new managed IP for step 8.

## 7. Verify (fresh-box gate)

```bash
"$COMFY_ROOT"/../verify.sh 2>/dev/null || ./verify.sh                 # system_stats + catalog + TTS health
./verify.sh --with-prompt                                             # + small SDXL smoke (~9 GB VRAM)
./download_models.sh --check-only                                     # BOM audit
```

All mandatory checks must print `PASS` and end with `VERIFY OK`.

## 8. Point the DSH gateway at the new box

On the **DSH host** (not here), edit the gitignored `server/comfy.env` and
restart dsh:

```bash
export DSH_COMFY_BASE_URL=http://<new-managed-ip>:8188
export DSH_COMFY_POOL=http://<new-managed-ip>:8188,http://<new-managed-ip>:8189,...  # one per fleet port
```

The provider auto-detects how many endpoints are live (P8-M8), so listing more
ports than the box has GPUs is harmless.

---

## Appendix A — regenerate `models.manifest` (maintainers, on a reference host)

```bash
cd "$COMFY_ROOT"
{ find ComfyUI/models -type f -size +1k ! -name 'put_*' ! -name '*.aria2'
  find CosyVoice/pretrained_models -type f
} | while read -r f; do printf '%s\t%s\t-\n' "$f" "$(stat -c %s "$f")"; done \
  > /tmp/models.manifest
# then fill the url column from INSTALL.md sources and commit into this directory
```

## Appendix B — env knobs

| Var | Default | Meaning |
|---|---|---|
| `COMFY_ROOT` | `/root/comfy` | single path knob for all scripts + unit |
| `COMFY_GPU_IDS` | `1 2 3 4 5 6 7` | fleet GPUs (port = 8188 + id) |
| `COMFY_BOOT_TIMEOUT` | `180` | per-instance readiness wait (s) |
| `COSY_UDS` | `$COMFY_ROOT/log/tts.sock` | TTS unix socket |
| `COMFY_PORT` | `8188` | main-engine port (verify.sh) |
