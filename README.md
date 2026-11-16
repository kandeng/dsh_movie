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

**How the pieces communicate** — three surfaces, at three different boundaries:

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

**Roadmap.** On this foundation we plan world-model tooling — e.g. **3D Gaussian
Splatting (3DGS)** and an **asset market** for movie-making skills, characters,
and scenes — to make it easier to generate movies (especially interactive ones)
and to support world-model research. As a future step we also plan to reach
external services through **MCP (Model Context Protocol) plugins** (DSH already
ships MCP client/resources packages), complementing the off-host model access
described above.

dsh_movie runs **no account store of its own**: the app **cannot start without a
Synapse homeserver on `http://127.0.0.1:8008` (`server_name: localhost`)**; if
Synapse is down you will see a "Startup failed / Failed to fetch" screen from a
refused `/_matrix/client/v3/account/whoami` call.

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
| `server/plugins/` | —                     | Matrix identity, Matrix chat, and movie gateway  |
