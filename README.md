# AsterMux

**Languages:** **English** · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md)

[![CI](https://github.com/kiddy1911/AsterMux/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kiddy1911/AsterMux/actions/workflows/ci.yml)
[![CodeQL](https://github.com/kiddy1911/AsterMux/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/kiddy1911/AsterMux/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/kiddy1911/AsterMux?sort=semver)](https://github.com/kiddy1911/AsterMux/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-2ea44f.svg)](LICENSE)
[![Language: TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js >=22.12](https://img.shields.io/badge/Node.js-%3E%3D22.12-339933?logo=node.js&logoColor=white)](package.json)
[![Container: GHCR](https://img.shields.io/badge/container-GHCR-2496ED?logo=docker&logoColor=white)](https://github.com/kiddy1911/AsterMux/pkgs/container/astermux)

**Adaptive, model-agnostic gateway for Cursor ACP.**

AsterMux exposes Cursor-backed models through familiar OpenAI and Anthropic HTTP
interfaces while keeping the expensive Cursor Agent processes warm, bounded,
and reusable. It is designed for both high-throughput gateways and small VPS
hosts: the same execution ceilings can run fully warm for minimum latency or
shrink to configurable warm floors to reduce idle memory.

AsterMux is an independent community project. Cursor is an upstream runtime, not
the product identity.

## What makes AsterMux different

- **Universal Model Pool** — persistent ACP workers are not tied to a model.
  Each fresh ACP session selects the requested model from the Agent-advertised
  configuration, so Grok, GPT, Gemini, Claude, Composer, and future Cursor
  models share the same optimized worker pools.
- **Three compatibility surfaces** — OpenAI Chat Completions, OpenAI Responses,
  and Anthropic Messages are translated at the HTTP edge.
- **Stateless external tools by default** — Chat/Anthropic tool turns rebuild
  context from caller history instead of parking a live session per user.
- **Dual-lane scheduler** — latency-sensitive interactive traffic is isolated
  from batch / structured-output work, with bounded queues and controlled lane
  borrowing.
- **Elastic memory** — `*_POOL_SIZE` sets the peak physical ceiling while
  `*_WARM_SIZE` controls idle residency. Excess workers scale up on demand and
  retire after an idle TTL.
- **Structured-output path** — allowlisted one-shot output tools can run on the
  batch lane with schema validation and bounded repair.
- **Observable by design** — status, Prometheus metrics, queue wait, execution
  time, worker counts, warm floors, Tool state, and repair statistics are
  exposed without inspecting Cursor processes manually.

## Architecture at a glance

```text
OpenAI / Responses / Anthropic clients
                 |
                 v
          AsterMux HTTP edge
                 |
        +--------+---------+
        |                  |
 interactive lane       batch lane
        |                  |
        +---- universal ACP pools ----+
                                      |
                              per-session model select
                                      |
                                  Cursor Agent

external Tool request
        |
        v
stateless Tool ACP pool --> temporary MCP server --> tool_call
```

The physical worker count is independent of the number of models exposed by the
Cursor account. See [Architecture](docs/ARCHITECTURE.md) for the invariants and
execution lifecycle.

## Requirements

- Node.js 22.12+ when running from source.
- Cursor Agent CLI installed and authenticated, or a `CURSOR_API_KEY` for
  headless use.
- For external client tools, a Cursor ACP build that exposes the required MCP
  capabilities.

Install the Cursor Agent using Cursor's official instructions, then verify that
models are visible:

```bash
agent --list-models
```

## Choose how to run AsterMux

AsterMux currently has four supported run paths. Docker users do **not** need a
local Cursor Agent installation because the published image installs the Agent
inside the container.

| Method | Best for | Source checkout required? |
|---|---|---:|
| **GHCR Docker image** | Fastest server/VPS deployment | No |
| **Docker Compose** | Long-running deployment with repository-managed config | Yes |
| **From source** | Development, customization, debugging | Yes |
| **macOS service / menu bar** | Local background operation on macOS | Yes |

### 1. GHCR Docker image — fastest

Create a private environment file with your own credentials:

```bash
cat > .env <<'EOF'
CURSOR_API_KEY=replace-with-your-cursor-key
ASTERMUX_API_KEY=replace-with-your-own-gateway-key
EOF
chmod 600 .env
```

Then start AsterMux:

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:latest
```

For production, pin a release tag such as
`ghcr.io/kiddy1911/astermux:v0.1.2` instead of `latest`.

### 2. Docker Compose — recommended for repository deployments

```bash
git clone https://github.com/kiddy1911/AsterMux.git
cd AsterMux
cp .env.example .env
# Edit .env and set CURSOR_API_KEY. Set ASTERMUX_API_KEY before remote exposure.

docker compose up --build -d
```

Compose binds to `127.0.0.1:8787` by default. Change `ASTERMUX_BIND_ADDR` only
when remote access is intentional.

### 3. From source

Install and authenticate the Cursor Agent first, then:

```bash
git clone https://github.com/kiddy1911/AsterMux.git
cd AsterMux
npm ci
npm run build

export CURSOR_API_KEY='replace-with-your-cursor-key'   # optional if Agent is already authenticated
export ASTERMUX_API_KEY='replace-with-your-own-gateway-key'
npm start
```

### 4. macOS background service

After building from source, install the launcher and enable the user LaunchAgent:

```bash
chmod +x scripts/astermux
mkdir -p ~/.local/bin
ln -sf "$(pwd)/scripts/astermux" ~/.local/bin/astermux
export ASTERMUX_ROOT="$(pwd)"

astermux enable
astermux health
```

For macOS service mode, authenticate the local Cursor Agent before enabling the
service. The optional menu-bar controller lives in `apps/macos-menu/`.

All methods use the same default endpoint: `http://127.0.0.1:8787`.

For start/stop, logs, upgrades, remote binding, and troubleshooting, see
[Running AsterMux](docs/RUNNING.md) and [Operations](docs/OPERATIONS.md).

## First request

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY' \
  -d '{
    "model": "cursor-grok-4.6-high",
    "messages": [{"role":"user","content":"Reply exactly OK"}]
  }'
```

If `ASTERMUX_API_KEY` is unset, the Authorization header is not required. Do not
expose an unauthenticated gateway to an untrusted network.

## API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Lightweight health probe |
| `GET` | `/health` | JSON runtime/config summary |
| `GET` | `/v1/models` | Models visible to the configured Cursor account |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions compatible |
| `POST` | `/v1/responses` | OpenAI Responses compatible |
| `POST` | `/v1/messages` | Anthropic Messages compatible |
| `POST` | `/v1/batches` | Persistent asynchronous batch jobs when enabled |
| `GET` | `/v1/runtime/status` | Scheduler / pool / Tool runtime state |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/` | Local dashboard |
| `GET` | `/docs` | Rendered operations guide |

AsterMux-owned response metadata uses `X-AsterMux-*` headers, including pool
lane, queue wait, execution time, worker lane, Tool mode, repair metadata, and
workspace/mode controls.

## Model handling

`ASTERMUX_DEFAULT_MODEL` is only the fallback when the caller omits a model. It
no longer determines which model receives the fast path.

With ACP pooling enabled:

1. A physical Cursor Agent starts without a model identity.
2. A fresh ACP session advertises model/config choices.
3. AsterMux resolves the public model id against those choices.
4. Reasoning/effort, fast, thinking, and context options are applied only from
   values the Agent actually advertises.
5. The request runs on the same universal pool used by every other model.

`ASTERMUX_STRICT_MODEL=true` rejects unknown model ids rather than silently
falling back to the ACP session default.

## External tools

AsterMux can translate OpenAI/Anthropic function tools to a temporary MCP server
owned by the request. The default Chat/Anthropic lifecycle is stateless:

```text
HTTP turn N
  -> new isolated ACP session
  -> requested model selected
  -> temporary MCP server exposes caller tools
  -> Cursor returns tool_call
  -> HTTP response ends
  -> ACP session is closed; no parked owner slot remains

HTTP turn N+1
  -> caller replays assistant tool_call + tool result + current history
  -> AsterMux reconstructs the turn in a fresh session
```

Use `X-AsterMux-Tool-Mode: stateful` only for integrations that deliberately
require a live continuation. Responses API keeps its standards-compatible
stateful continuation behavior unless the caller explicitly opts into a
reconstructable stateless flow.

## Performance profiles

### Maximum warm performance

Warm floors default to `-1`, which means **warm == max**. This preserves the
lowest first-burst latency:

```env
ASTERMUX_USE_ACP=true
ASTERMUX_ACP_POOL_SIZE=2
ASTERMUX_ACP_BATCH_POOL_SIZE=8
ASTERMUX_ACP_TOOL_POOL_SIZE=2
ASTERMUX_ACP_INTERACTIVE_WARM_SIZE=-1
ASTERMUX_ACP_BATCH_WARM_SIZE=-1
ASTERMUX_ACP_TOOL_WARM_SIZE=-1
```

In the current test environment, the model-agnostic 2/8/2 fully-warm profile
idled around **1.63 GiB**, down from roughly **2.16 GiB** before the universal
pool refactor, without reducing the configured execution slots.

### Elastic 2/8/2 profile

Keep the same peak ceiling but fewer workers resident while idle:

```env
ASTERMUX_USE_ACP=true

ASTERMUX_ACP_POOL_SIZE=2
ASTERMUX_ACP_INTERACTIVE_WARM_SIZE=2

ASTERMUX_ACP_BATCH_POOL_SIZE=8
ASTERMUX_ACP_BATCH_WARM_SIZE=2

ASTERMUX_ACP_TOOL_POOL_SIZE=2
ASTERMUX_ACP_TOOL_WARM_SIZE=1

ASTERMUX_ACP_ELASTIC_IDLE_MS=120000
```

This configuration idled around **0.71 GiB** in the same canary while retaining
2/8/2 ceilings. The first burst after shrink pays worker warm-up once; after
scale-up, steady-state throughput returns to the full ceiling.

### Validated 1 vCPU / 1 GiB profile

```env
ASTERMUX_USE_ACP=true
ASTERMUX_ACP_POOL_SIZE=1
ASTERMUX_ACP_INTERACTIVE_WARM_SIZE=1
ASTERMUX_ACP_BATCH_POOL_SIZE=3
ASTERMUX_ACP_BATCH_WARM_SIZE=1
ASTERMUX_ACP_TOOL_POOL_SIZE=1
ASTERMUX_ACP_TOOL_WARM_SIZE=1
ASTERMUX_ACP_ELASTIC_IDLE_MS=60000
ASTERMUX_ACP_BATCH_QUEUE_MAX=12
ASTERMUX_BATCH_CONCURRENCY=3
```

With the Cursor Agent build used during validation, this profile idled at roughly
**0.43–0.46 GiB**. A concurrent three-request structured-output test peaked at
about **0.82 GiB**, completed 3/3 successfully, and remained healthy without an
OOM. Treat these numbers as sizing guidance rather than a guarantee across
Agent versions and kernels.

## SDK

```js
import { createAsterMuxClient } from "astermux";

const client = createAsterMuxClient({
  apiKey: process.env.ASTERMUX_API_KEY,
  autoStart: true,
});

const result = await client.chatCompletionsCreate({
  model: "cursor-grok-4.6-high",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(result.choices?.[0]?.message?.content);
```

For the official OpenAI SDK:

```js
import OpenAI from "openai";
import { getOpenAIOptionsAsync } from "astermux";

const openai = new OpenAI(await getOpenAIOptionsAsync());
```

## Dashboard and local operations

The local dashboard is available at `/`. The documentation page is `/docs`.
The launcher script can be installed as `~/.local/bin/astermux` for background
start/stop, health checks, request viewing, and macOS launchd integration.

See [Operations](docs/OPERATIONS.md).

## Configuration

AsterMux configuration is namespaced under `ASTERMUX_*`. Cursor's own upstream
credentials and executable controls intentionally retain the `CURSOR_*` prefix.

See [Configuration reference](docs/CONFIGURATION.md) for every supported
variable and [`.env.example`](.env.example) for a deployable template.

## Security defaults

- Bind to `127.0.0.1` unless remote access is intentional.
- Set `ASTERMUX_API_KEY` before exposing the HTTP API beyond the host.
- Keep `CURSOR_API_KEY`, `.env`, account directories, and migration archives out
  of Git.
- Chat-only mode uses an isolated temporary workspace by default.
- Real workspace access is opt-in and should be treated as agent execution.
- Raw ACP debug and verbose request logging can contain sensitive content; leave
  them disabled in production.

See [Security policy](SECURITY.md).

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The current suite covers model-agnostic pooling, per-session model selection,
Tool lifecycle, bounded queues, elastic warm floors, batch scheduling,
structured-output repair, OpenAI/Responses/Anthropic compatibility, workspace
isolation, and server lifecycle behavior.

## Project layout

```text
src/                    TypeScript runtime and protocol adapters
src/protocols/handlers/ HTTP protocol handlers
ui/                     Local dashboard and docs UI
docs/                   Architecture, configuration, operations, model notes
examples/               SDK, raw HTTP, streaming, and latency examples
scripts/astermux        Local launcher / macOS service helper
apps/macos-menu/        Optional macOS menu-bar controller
```

## Community and support

- [Contributing](CONTRIBUTING.md) — development workflow and pull-request expectations.
- [Support](SUPPORT.md) — where to ask setup and usage questions.
- [Security](SECURITY.md) — private vulnerability reporting and deployment boundaries.
- [Code of Conduct](CODE_OF_CONDUCT.md) — community participation standards.

## License

AsterMux is open source under the [MIT License](LICENSE).
