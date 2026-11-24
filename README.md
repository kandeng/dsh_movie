# dsh_movie

## 1. Objective

dsh_movie is a collaborative, chat-driven movie-making **foundation**, built as a
pnpm monorepo on the **DeepSeek Harness (DSH)** plugin kernel. It rests on three
pillars:

1. **DSH host (server-side)** — a CPU-only orchestration host composed entirely
   of plugins (agent loop, tools, sessions, jobs). It runs **zero Python and zero
   model code** and delegates all inference off-host.
2. **Matrix / Synapse chatroom (server-side + client-side)** — the single
   identity and chat authority. The browser logs into Synapse directly, and each
   Matrix room is one session with its own server-side workspace.
3. **Vue Flow graph canvas (client-side)** — an infinite canvas for editing a
   **server-authoritative** workflow graph: the client draws and submits, the
   server owns, validates, and executes it.

Because DSH has **no privileged core** (nothing is hard-wired above the plugin
layer — even the agent loop, tools, and gateway are ordinary plugins), the
built-in movie pipeline is just one configuration of plugins. That makes the system a **general-purpose foundation**:
new domains are added as **plugins**, not core rewrites. We intend to use it as a
base for **world-model** work — above all the generation of **interactive
movies** — by deploying the world-model services and the interactive-movie
application functions as plugins on top of the DSH + Synapse + Canvas foundation.

**How the pieces communicate** — four surfaces, at four different boundaries:

- **Client ↔ server — three legs behind one typed SDK.** *Leg A*: the Matrix
  Client-Server API (identity, chat, media). *Leg B*: a ComfyUI-protocol
  execution channel (submit the graph + a live lifecycle stream). *Leg C*: the
  DSH gateway RPC + WebSocket mux (canvas, workflow, movie, assets, registry).
  One Matrix token authenticates all three.
- **On the canvas — typed slots are the dataflow contract.** Nodes connect
  through typed media slots (`TEXT | IMAGE | VIDEO | AUDIO`); execution **events
  carry lifecycle only** (progress/status), never dataflow. (Pub/sub as a
  dataflow mechanism was deliberately rejected — see `doc/design/`.)
- **Inside the host — Cordis services + typed events.** Plugins communicate by
  injecting services (`ctx.llm`, `ctx.tools`, `ctx.jobs`, `ctx.subagents`, …) and
  emitting typed events with dispatch modes; every registration is a reversible
  effect.
- **External services & models — delegated off-host.** All inference is reached
  over **HTTPS** through `ctx.llm` / `ctx.credentials` using OpenAI-compatible
  (or provider-native) APIs — a cloud provider (Bailian), or servers **inside the
  enterprise firewall** (any OpenAI-compatible runtime such as vLLM, Ollama, or
  SGLang).

**Roadmap.** A first slice of this vision has **shipped**: a **plugins marketplace**
(Phase 7) reaching external ry ·services through **MCP (Model Context Protocol) tool
plugins** (DSH already ships MCP client/resources packages), complementing the
off-host model access described above. Every external source — a built-in adapter
or a third-party/user MCP server — runs as a **sandboxed OS child process** under
the **SPR supervisor** (`systemd-run --user --scope` wrapping `bwrap`, with
network allow-lists and memory/CPU caps), so no third-party code ever executes
inside the host. It surfaces **`SKILL.md` craft skills** through a Plugins page
and a two-trigger editor **Import**/**Run** flow, guarded by a server-global
**yellow/orange/red trust ladder** (heuristic scan + user reports; orange gates
execution behind explicit consent, red blocks it). On this foundation we still
plan broader world-model tooling — e.g. **3D Gaussian Splatting (3DGS)** and a
full **asset market** for movie-making characters and scenes — to make it easier
to generate movies (especially interactive ones) and to support world-model
research.

For the full system design see [`doc/architecture.md`](doc/architecture.md) and
the phase plans under [`doc/design/`](doc/design/).

## 2. Prerequisite

- **Node.js** `>= 24.9.0`
- **pnpm** (the repo is a pnpm workspace)
- **PostgreSQL 14** — Synapse's database (set up in §3.3)
- **Matrix Synapse** homeserver on `127.0.0.1:8008`, `server_name: localhost`,
  backed by PostgreSQL (set up in §3.4)
- *(Optional)* An **Alibaba Bailian / DashScope** API key to enable text (and,
  when a video model id is set, video) generation. Without it the app still runs;
  generator nodes report `model-unavailable`.
- *(Optional)* **ZeroTier** + a remote **ComfyUI GPU host** (e.g. the H20 server
  `yw01` behind the enterprise firewall) for local image/video/audio generation —
  set up in §3.5.

## 3. Installation

### 3.1 DSH and other server-side packages

From the repository root:

```bash
pnpm install
```

This installs every workspace package **and** the DSH engine
(`@deepseek-ai/dsh`, pulled from the registry as a normal `server` dependency),
so there is **no separate DSH clone or global install step**.

Then configure the server credentials:

```bash
cd server
cp .env.example .env
# edit .env — at minimum BAILIAN_API_KEY and SYNAPSE_ADMIN_TOKEN
cd ..
```

`server/.env` keys: `SYNAPSE_BASE_URL`, `SYNAPSE_SERVER_NAME`,
`SYNAPSE_ADMIN_TOKEN`, `SYNAPSE_BOT_USER_ID`, `SYNAPSE_ROOM_ID`,
`BAILIAN_API_KEY`. `.env` is gitignored — never commit it; the committed
`server/.env.example` holds names and placeholders only.

### 3.2 Canvas and other client-side packages

The browser side — the Vue 3 + **Vue Flow** canvas, the chat shell, the SDK, and
the i18n catalogs — is installed by the **same** root `pnpm install` above (they
are workspace packages: `client/web`, `client/sdk`, `client/i18n`, plus the
shared `protocol`). No separate install step is needed.

Client defaults live in [`client/web/src/config.ts`](client/web/src/config.ts)
and target this local stack. Override them with `VITE_*` environment variables if
your services live elsewhere:

| Variable            | Default                       | Purpose                          |
| ------------------- | ----------------------------- | -------------------------------- |
| `VITE_HS_URL`       | `/` (proxied to `:8008`)      | Matrix homeserver base URL       |
| `VITE_SERVER_NAME`  | `localhost`                   | Matrix server name               |
| `VITE_GATEWAY_URL`  | `/comfy` (proxied to `:8788`) | Movie gateway                    |
| `VITE_BOT_ID`       | `@dsh_bot:localhost`          | The agent bot to invite into a room |

### 3.3 PostgreSQL systemd service (install before Synapse)

Synapse stores everything in PostgreSQL, run as a **user-level** systemd service
named `dsh-postgre` (PostgreSQL 14, data dir `~/dsh-pgdata`, port **5432**). Set
this up **before** Synapse: `dsh-synapse` declares `Requires=dsh-postgre.service`
and `After=dsh-postgre.service`, so starting Synapse brings the database up
first — the two are bundled.

Create `~/.config/systemd/user/dsh-postgre.service`:

```ini
[Unit]
Description=PostgreSQL cluster (dsh_movie, port 5432) for Synapse
After=network.target

[Service]
Type=notify
ExecStart=/usr/lib/postgresql/14/bin/postgres -D %h/dsh-pgdata
ExecReload=/bin/kill -HUP $MAINPID
KillMode=mixed
KillSignal=SIGINT
TimeoutStopSec=60
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Initialise the cluster once, pin the port/socket, then enable + start it:

```bash
/usr/lib/postgresql/14/bin/initdb -D ~/dsh-pgdata -U "$USER" --encoding=UTF8 \
  --auth-local=trust --auth-host=trust
# append to ~/dsh-pgdata/postgresql.conf:
#   port = 5432
#   listen_addresses = 'localhost'
#   unix_socket_directories = '<home>/dsh-pgdata'
systemctl --user daemon-reload
systemctl --user enable --now dsh-postgre
```

Provision the Synapse role/database (Synapse requires UTF-8 with the C locale):

```bash
psql -h 127.0.0.1 -p 5432 -U "$USER" -d postgres -c \
  "CREATE ROLE synapse WITH LOGIN PASSWORD 'synapse';"
psql -h 127.0.0.1 -p 5432 -U "$USER" -d postgres -c \
  "CREATE DATABASE synapse OWNER synapse ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;"
psql -h 127.0.0.1 -p 5432 -U "$USER" -d synapse -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

### 3.4 Synapse systemd service

Install the Postgres driver into your Synapse venv and point `homeserver.yaml` at
the database you created in §3.3:

```bash
pip install psycopg2-binary   # inside the Synapse venv
```

```yaml
database:
  name: psycopg2
  txn_limit: 10000
  args:
    user: synapse
    password: synapse
    database: synapse
    host: 127.0.0.1
    port: 5432
    cp_min: 5
    cp_max: 10
```

Run Synapse as a **user-level** systemd service named `dsh-synapse`. Create
`~/.config/systemd/user/dsh-synapse.service`:

```ini
[Unit]
Description=Matrix Synapse homeserver (dsh_movie, 127.0.0.1:8008)
After=network.target dsh-postgre.service
Requires=dsh-postgre.service

[Service]
Type=simple
ExecStart=%h/synapse-venv/bin/python -m synapse.app.homeserver -c %h/synapse-data/homeserver.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable + start it, then check the status:

```bash
systemctl --user daemon-reload
systemctl --user enable --now dsh-synapse
systemctl --user status dsh-synapse
```

Adjust the `ExecStart` paths to wherever your Synapse venv and `homeserver.yaml`
live (`%h` expands to your home directory). Optionally run
`loginctl enable-linger $USER` so the service keeps running after you log out.
For a quick manual start instead of systemd:
`python -m synapse.app.homeserver -c <your-homeserver.yaml>`.

dsh_movie keeps **no account store of its own**, so the app **cannot start without
a running Synapse** on `http://127.0.0.1:8008` (`server_name: localhost`). If the
service is down, the web client's `/_matrix/client/v3/account/whoami` call is
refused and you get a "Startup failed / Failed to fetch" screen — start
`dsh-postgre` + `dsh-synapse` and reload the page.

On first start Synapse creates its own schema (~176 tables). If your homeserver
lives elsewhere, point `SYNAPSE_BASE_URL` / `SYNAPSE_SERVER_NAME` in
`server/.env` (and `VITE_HS_URL` / `VITE_SERVER_NAME` for the client) at it.

View the service logs with `journalctl` (user-level, so pass `--user`):

```bash
journalctl --user -u dsh-synapse -f          # follow Synapse
journalctl --user -u dsh-postgre -f          # follow PostgreSQL
journalctl --user -u dsh-synapse -n 200 --no-pager
```

Journald retains logs on disk; reclaim space when needed:

```bash
journalctl --user --vacuum-time=7d
journalctl --user --vacuum-size=100M
```

### 3.5 Remote H20 ComfyUI over ZeroTier (optional)

The GPU media backend (ComfyUI with Wan 2.2 T2V, SDXL + InstantID, Qwen-Image,
CosyVoice2 TTS, Stable Audio Open, …) runs on the **H20 server `yw01`**, which
sits behind an enterprise firewall with **no inbound access**. Connectivity is
provided by a **ZeroTier** overlay: both ends dial *out* to ZeroTier's public
root servers (TCP/UDP 9993), so no firewall or port-forwarding changes are
needed. Tailscale was evaluated first, but its Google-hosted control plane is
throttled by the GFW from this network (registration POSTs time out), whereas
ZeroTier's roots and Cloudflare-fronted API are reachable — so **ZeroTier is
the working overlay** and Tailscale is not used.

Current overlay facts: private network `2873fd00f2cc42ff` (org `kdeng`); H20
node `3e8f2d44bc` → managed IP `10.188.8.105`; this box node `9c7fc34643`.

**1. Join the network from this machine** (one-time; installs `zerotier-one`,
joins the network, and prints both node addresses):

```bash
bash extension/zerotier/zt_install.sh
```

The network is **private**, so authorize BOTH members once in ZeroTier Central
(`my.zerotier.com` → network → Members → tick *Auth*). A member's managed IP is
stable for the life of the (network, member) pair — it does not change per
reconnect — so the address below only changes if the network is recreated.

**2. Verify the remote ComfyUI** (read-only health + model-catalog check):

```bash
cd extension/comfy && npm install   # one-time
COMFY_REMOTE_BASE_URL=http://10.188.8.105:8188 node src/smoke.ts   # ALL PASS ⇒ link good
curl -s http://10.188.8.105:8188/model_catalog/categories           # raw catalog API
```

**3. Point the DSH gateway at the H20** — the Phase-8 media provider treats a
remote GPU host as an env-only switch. Note `DSH_*` are *launch-control* vars
that `dsh-app-boot` rejects inside `server/.env`; they live in the gitignored
`server/comfy.env`, which `start.sh` exports:

```bash
# server/comfy.env — static managed IP (works today)
export DSH_COMFY_BASE_URL=http://10.188.8.105:8188
# …or fully dynamic: resolve the H20's CURRENT managed IP from the ZeroTier
# Central API at every health probe, then DSH_COMFY_BASE_URL can stay blank:
export DSH_COMFY_ZEROTIER=2873fd00f2cc42ff/3e8f2d44bc
export DSH_ZEROTIER_API_TOKEN=<Central → Account API token>
```

Then `./stop.sh && ./start.sh`. Image/video generators execute on the H20
instead of reporting `model-unavailable`. A second (local) ComfyUI can join the
pool via `DSH_COMFY_POOL` for round-robin + submit-failover.

For agent/operator access (model catalog introspection, job submission,
output fetch) an MCP bridge lives in [`extension/comfy/`](extension/comfy/README.md);
the H20-side operator and provenance docs are
[`deployment/H20/comfy/README.md`](deployment/H20/comfy/README.md) and
[`deployment/H20/comfy/INSTALL.md`](deployment/H20/comfy/INSTALL.md).
Security notes: the ComfyUI API has **no
authentication** — exposure is limited to the ZeroTier private network
(authorize only your own nodes; never publish the network), and the CosyVoice2
TTS socket is not network-reachable.

## 4. Run

You run two processes: the DSH server (identity + chat + gateway) and the web
client dev server.

**1. Start the server** (from the repo root):

```bash
pnpm start:web
```

This launches the DSH host with the movie profile: the identity `/auth` listener
on **8787** and the movie gateway (Leg B execution + Leg C RPC/WS) on **8788**.
For a server with no web UI, use `pnpm start:headless`.

**2. Start the web client** (in a second terminal, from the repo root):

```bash
pnpm dev:web
```

Then open **http://127.0.0.1:5173**. The Vite dev server proxies `/_matrix` to
Synapse (8008) and `/comfy` to the gateway (8788).

Other useful commands (from the repo root):

```bash
pnpm typecheck      # typecheck every workspace package
pnpm build:web      # production build of the web client
pnpm dump:config    # print the resolved DSH server config
```

## 5. File structure

| Path              | Package               | Purpose                                          |
| ----------------- | --------------------- | ------------------------------------------------ |
| `protocol/`       | `@dsh-movie/protocol` | Shared wire contract (nodes, graph, RPC types)   |
| `client/sdk/`     | `@dsh-movie/sdk`      | Browser SDK for the three legs (chat/exec/RPC)   |
| `client/web/`     | `@dsh-movie/web`      | Vue 3 + Vue Flow canvas and chat client          |
| `client/i18n/`    | `@dsh-movie/i18n`     | Locale catalogs + Vite CJK-extraction plugin     |
| `server/`         | `dsh-movie-server`    | DSH host, profiles, and scripts                  |
| `server/plugins/` | —                     | Matrix identity, Matrix chat, movie gateway, and the plugins marketplace (SPR supervisor) |
| `extension/`      | —                     | Remote H20 ops assets: `zerotier/` (overlay join script), `tailscale/` (legacy tailnet join script), and `comfy/` (H20 docs + `comfy-remote` MCP bridge) |
