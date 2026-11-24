# H20 — ComfyUI runtime stack

Host index for the DSH-Movie GPU provider host **`yw01`**. This directory
publishes the runtime that actually runs on the box: launchers, the systemd
unit, and the operator/provenance docs.

| File | What it is |
| --- | --- |
| `comfy_start.sh` | Starts the GPU0 main engine (:8188) + the CosyVoice2 TTS sidecar, then delegates to `comfy_start_multi.sh` |
| `comfy_start_multi.sh` | Starts the fleet instances on GPUs 1-7 (:8189-:8195) |
| `comfy_stop_multi.sh` | Stops **only** the fleet instances (:8189-:8195); leaves :8188 and the TTS server running |
| `comfy-multi.service` | The installed systemd unit (`/etc/systemd/system/comfy-multi.service`) |
| `README.md` | H20-side operator runbook (start/stop, HTTP API, model catalog, TTS socket, remote access) |
| `INSTALL.md` | H20-side install provenance (24 models, ~107 GB, deviations, acceptance runs) |
| `DEPLOY.md` | Ordered bring-up runbook for a **fresh** GPU box (prereqs → models → TTS → unit → ZeroTier → verify → gateway wiring) |
| `download_models.sh` | Manifest-driven, size-verified model provisioning (`--check-only` audits an existing box) |
| `models.manifest` | Model bill-of-materials TSV (`dest<TAB>size_bytes<TAB>url`), generated on the reference host |
| `verify.sh` | Fresh-box acceptance gate (system_stats + model_catalog + TTS health; `--with-prompt` adds an SDXL smoke) |
| `cosyvoice_tts_server.py` | The CosyVoice2 unix-socket TTS service launched by `comfy_start.sh` |

## Host

- **`yw01`** — the H20 GPU server, reachable by the DSH gateway over the
  ZeroTier overlay only.
- **8x NVIDIA H20**, 97,871 MiB each (`nvidia-smi` indices 0-7).
- ComfyUI **0.46.0** at `/root/comfy/ComfyUI` (upstream commit `f99de883d`),
  running on the Python venv `/root/comfy/venv`.
- CosyVoice2 TTS runs on `/root/comfy/venv-cosy` (`/root/comfy/script/cosyvoice_tts_server.py`).

## Endpoints

| GPU | Port | Started by | Notes |
| --- | --- | --- | --- |
| 0 | 8188 | `comfy_start.sh` | Main engine, plain `nohup` (no systemd dependency) |
| 1-7 | 8189-8195 | `comfy_start_multi.sh` | `CUDA_VISIBLE_DEVICES=$i` pinning, one instance per GPU |

Each fleet instance gets its own `--output-directory /root/comfy/output-<i>`
and `--user-directory /root/comfy/user-<i>`, so generated filenames and the
per-instance sqlite database never collide. The model set under
`/root/comfy/ComfyUI/models` is shared by all instances rather than copied per
instance. Instance logs land in `/root/comfy/log/comfyui-<port>.log`.

`comfy_start_multi.sh` is idempotent: an instance whose port already answers
`/system_stats` is skipped, and it waits up to `COMFY_BOOT_TIMEOUT` (default
180 s) for each new instance to answer before reporting it ready.

Stopping the fleet is `comfy_stop_multi.sh`. The GPU0 main engine is stopped
separately with the host-side `/root/comfy/comfy_stop.sh`, by design — the
systemd unit's `ExecStop` touches the fleet only.

The CosyVoice2 TTS sidecar is started by `comfy_start.sh` and listens on the
unix socket `/root/comfy/log/tts.sock`; it is not reachable over TCP or over
the overlay.

## Persistence

The fleet is supervised by the systemd unit `comfy-multi.service`:

- `Type=oneshot` with `RemainAfterExit=yes` — systemd runs the launcher once and
  keeps the unit active; the ComfyUI processes themselves are detached
  (`setsid nohup`), so the unit does not supervise them directly.
- `ExecStart=/root/comfy/comfy_start.sh` (which brings up :8188 + TTS and then
  the fleet), `ExecStop=/root/comfy/comfy_stop_multi.sh`.
- `WorkingDirectory=/root/comfy`, `TimeoutStartSec=900`.
- Installed at `/etc/systemd/system/comfy-multi.service` and enabled.

## Network

The host sits behind an enterprise firewall with **no inbound access**. It is
reachable only over the ZeroTier overlay, on the managed IP **10.188.8.105**;
ports 8188-8195 are bound to `0.0.0.0` but are only reachable from nodes
authorized in the ZeroTier controller. The ComfyUI API itself has **no
authentication**, so exposure is limited to the overlay.

## How the DSH gateway pools these endpoints

The Phase-8 media provider treats the remote GPU host as an env-only switch.
`DSH_*` are launch-control variables, so they live in the gitignored
`server/comfy.env`, which the repo-root `start.sh` exports:

```bash
# server/comfy.env
export DSH_COMFY_BASE_URL=http://10.188.8.105:8188
export DSH_COMFY_POOL=http://10.188.8.105:8188,http://10.188.8.105:8189,http://10.188.8.105:8190,http://10.188.8.105:8191,http://10.188.8.105:8192,http://10.188.8.105:8193,http://10.188.8.105:8194,http://10.188.8.105:8195
```

`DSH_COMFY_BASE_URL` arms the provider against the main engine on :8188;
`DSH_COMFY_POOL` adds the remaining endpoints for round-robin dispatch and
submit-failover. Both are set on the DSH host, not here.

For operator/agent introspection of the same host (model catalog, health, job
submission, output fetch) there is an MCP bridge on the client side in
[`extension/comfy/`](../../extension/comfy/README.md).
