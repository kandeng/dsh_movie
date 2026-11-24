# comfy-remote — MCP bridge to the H20 ComfyUI service

Operator/agent bridge from this workstation (and any MCP host) to the
ComfyUI media factory on the remote H20 GPU server (`yw01`,
`10.188.8.105` ZeroTier managed IP), reached over the **ZeroTier** overlay —
the H20 sits behind an enterprise firewall with no inbound access.
(Tailscale remains installed as a legacy alternative; see
`deployment/H20/comfy/README.md` §Remote access.)

| File | What it is |
| --- | --- |
| `deployment/H20/comfy/README.md` | H20-side operator doc (start/stop, HTTP API, model catalog, TTS socket, remote-access runbook) — snapshot of the H20 host file |
| `deployment/H20/comfy/INSTALL.md` | H20-side install provenance (24 models, ~107 GB, deviations, acceptance runs) — snapshot of the H20 host file |
| `src/server.ts` | The MCP server (stdio) |
| `src/smoke.ts` | Upstream smoke check (no MCP layer needed) |
| `../zerotier/zt_install.sh` | Local-side ZeroTier install/join script (prerequisite) |

> Naming: this is **not** the Phase-2 canvas `comfy-bridge`
> (`server/plugins/dsh-movie-gateway/src/comfy-bridge/`) and **not** the
> Phase-8 media seam (`movie-executor/comfy-provider.ts`). Those stay
> authoritative for the movie pipeline; per「模型调用一律经 DSH」, application
> model calls go through the DSH gateway, which reaches the same H20 over the
> ZeroTier overlay (`DSH_COMFY_ZEROTIER` dynamic managed-IP resolution, or a
> static `DSH_COMFY_BASE_URL=http://10.188.8.105:8188` — env-only switches
> supported by `comfy-provider.ts`).

## Prerequisites

1. **ZeroTier overlay up on both ends** (H20 side already joined — `yw01` authorized):
   ```bash
   bash extension/zerotier/zt_install.sh   # local side, one-time join
   zerotier-cli listnetworks               # managed IP 10.188.8.x must show OK
   ```
2. **Dependencies** (Node >= 24.9 runs the `.ts` sources directly):
   ```bash
   cd extension/comfy && npm install
   ```

## Env

| Var | Default | Meaning |
| --- | --- | --- |
| `COMFY_REMOTE_BASE_URL` | `http://10.188.8.105:8188` | Upstream ComfyUI (H20 ZeroTier managed IP) |
| `COMFY_REMOTE_TOKEN` | *(empty)* | Optional bearer token if ComfyUI runs with `--api-key`; never logged |
| `COMFY_REMOTE_TIMEOUT_MS` | `900000` | Cap for blocking job waits |

## Smoke check

```bash
cd extension/comfy
node src/smoke.ts                        # health + model catalog (read-only)
COMFY_SMOKE_PROMPT=1 node src/smoke.ts   # + model-free upload→LoadImage→SaveImage→/view E2E
```

Exit code 0 = all pass; unreachable upstream fails closed with a ZeroTier overlay hint.

## MCP tools

| Tool | Upstream endpoint | Purpose |
| --- | --- | --- |
| `comfy_health` | `GET /system_stats` | Fail-closed reachability (powers a Supply-probe style badge) |
| `comfy_system_stats` | `GET /system_stats` | Versions, GPUs, VRAM, queue state |
| `comfy_model_catalog` | `GET /model_catalog[/{category}]` | **The Plugin → Models page data source**: 24 entries with `id`, `category`, `filename`, `size_human`, `lazy_loaded`, `purpose`, `loader`, `est_vram_gb`, `est_ram_gb`, ~100-word `description` |
| `comfy_model_categories` | `GET /model_catalog/categories` | Category list for tabs/filters |
| `comfy_object_info` | `GET /object_info[/{nodeClass}]` | Node capability / template coverage check |
| `comfy_queue` | `GET /queue` | Running + pending jobs |
| `comfy_submit_prompt` | `POST /prompt` | Submit an API-format workflow; optional `waitSeconds` inline tracking |
| `comfy_job_status` | `GET /history/{id}` | One-shot status + saved-file list |
| `comfy_wait_for_job` | `GET /history/{id}` (poll) | Block until success/error/timeout; returns per-file `/view` paths |
| `comfy_fetch_output` | `GET /view` | Download output bytes (base64, or `saveTo` a local path) |

Register in an MCP client (stdio):

```json
{
  "mcpServers": {
    "comfy-remote": {
      "command": "node",
      "args": ["/home/robot/dsh_movie/extension/comfy/src/server.ts"],
      "env": { "COMFY_REMOTE_BASE_URL": "http://10.188.8.105:8188" }
    }
  }
}
```

## Known boundaries

- The ComfyUI API has **no authentication**; exposure is limited by the
  ZeroTier private network (members must be authorized in ZeroTier Central).
  See `deployment/H20/comfy/README.md` §Remote access for the H20-side lockdown options.
- The CosyVoice2 TTS service listens on a **unix socket**
  (`/root/comfy/log/tts.sock`) on the H20 — not reachable over TCP/overlay;
  only via `ssh -L` socket forwarding. Not exposed as an MCP tool yet.
- Wan 2.2 generations are slow by design (~240 s smoke at 480p/49f);
  use `comfy_submit_prompt` fire-and-forget + `comfy_wait_for_job` rather
  than long blocking calls.
