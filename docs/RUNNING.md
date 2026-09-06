# Running AsterMux

AsterMux supports four practical run paths. Pick one based on whether you want a
prebuilt container, a repository-managed deployment, a development checkout, or
a macOS background service.

## Before you start

You need Cursor access in one of these forms:

- Docker/GHCR: set `CURSOR_API_KEY` in an environment file. The published image
  already contains Cursor Agent.
- Source/macOS: install Cursor Agent and either authenticate it locally or export
  `CURSOR_API_KEY` before starting AsterMux.

AsterMux listens on `127.0.0.1:8787` by default. Keep it on loopback unless you
intentionally expose it. If another machine can reach the gateway, set a strong
`ASTERMUX_API_KEY` and put TLS in front of it.

## Method 1 — GHCR Docker image

This is the shortest path for a VPS or server and does not require cloning the
repository.

### Configure

```bash
mkdir astermux && cd astermux
cat > .env <<'EOF_ENV'
CURSOR_API_KEY=replace-with-your-cursor-key
ASTERMUX_API_KEY=replace-with-your-own-gateway-key
EOF_ENV
chmod 600 .env
```

Do not commit this `.env` file or paste its real values into an issue.

### Start

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:latest
```

For a production deployment, pin a release instead of tracking `latest`:

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:v0.1.1
```

### Verify

```bash
curl http://127.0.0.1:8787/healthz
docker logs --tail 50 astermux
```

A healthy probe returns:

```text
ok
```

### Stop / remove

```bash
docker stop astermux
docker rm astermux
```

### Upgrade

If you use `latest`:

```bash
docker pull ghcr.io/kiddy1911/astermux:latest
docker rm -f astermux
```

Then run the same `docker run` command again. If you pin a version, replace the
old image tag with the new release tag before recreating the container.

## Method 2 — Docker Compose

Use this when you want the repository, `.env.example`, configuration reference,
and deployment file kept together.

### Install

```bash
git clone https://github.com/kiddy1911/AsterMux.git
cd AsterMux
cp .env.example .env
chmod 600 .env
```

Edit `.env` and set at least `CURSOR_API_KEY`. Set `ASTERMUX_API_KEY` before
exposing the port to another machine.

### Start

```bash
docker compose up --build -d
```

The current `compose.yaml` builds the image from the checked-out source and
publishes `127.0.0.1:8787` by default.

### Verify / logs

```bash
docker compose ps
curl http://127.0.0.1:8787/healthz
docker compose logs -f astermux
```

### Stop

```bash
docker compose down
```

### Upgrade

```bash
git pull --ff-only
docker compose up --build -d
```

For persistent batch state, `compose.yaml` mounts `./data` at `/app/data`. The
container runs as UID/GID `1001`. On a fresh host, if batch persistence reports
a permission error, create the directory with compatible ownership before
starting:

```bash
mkdir -p data
sudo chown -R 1001:1001 data
```

## Method 3 — run from source

Use source mode for development, local customization, profiling, or when you
want to manage Cursor Agent yourself.

### Requirements

- Node.js 18+
- Cursor Agent installed
- Cursor Agent authenticated locally, or `CURSOR_API_KEY` exported

### Build

```bash
git clone https://github.com/kiddy1911/AsterMux.git
cd AsterMux
npm ci
npm run build
```

### Start

AsterMux reads the process environment directly. It does not automatically load
a repository `.env` file in source mode.

```bash
export CURSOR_API_KEY='replace-with-your-cursor-key'   # omit if Agent login is already valid
export ASTERMUX_API_KEY='replace-with-your-own-gateway-key'
export ASTERMUX_PORT=8787
npm start
```

Or load your own private environment file into the shell before starting:

```bash
set -a
. /path/to/private/astermux.env
set +a
npm start
```

### Development checks

```bash
npm run typecheck
npm test
npm run build
```

## Method 4 — macOS background service and menu bar

This mode uses the same source build, but `scripts/astermux` manages the process
and can register a per-user `launchd` service.

### Build and install the launcher

```bash
git clone https://github.com/kiddy1911/AsterMux.git
cd AsterMux
npm ci
npm run build

chmod +x scripts/astermux
mkdir -p ~/.local/bin
ln -sf "$(pwd)/scripts/astermux" ~/.local/bin/astermux
export ASTERMUX_ROOT="$(pwd)"
```

Before enabling `launchd`, install and authenticate Cursor Agent locally. This
avoids storing a Cursor API key in the LaunchAgent plist.

### Commands

```bash
astermux start
astermux health
astermux restart
astermux stop
```

Install the login service:

```bash
astermux enable
```

Remove it:

```bash
astermux disable
```

Other launcher commands include `rebuild`, `folder`, `run`, and `requests`.
Launcher state and logs live under `~/.astermux/`.

The optional Swift menu-bar controller is under `apps/macos-menu/`.

## Test the API

After any run method is healthy:

```bash
curl http://127.0.0.1:8787/v1/models \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY'
```

Then send a completion:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY' \
  -d '{
    "model": "cursor-grok-4.6-high",
    "messages": [{"role":"user","content":"Reply exactly OK"}]
  }'
```

If `ASTERMUX_API_KEY` is unset, omit the Authorization header. Do not expose an
unauthenticated AsterMux endpoint to an untrusted network.

## Runtime URLs

| URL | Purpose |
|---|---|
| `http://127.0.0.1:8787/` | Dashboard |
| `http://127.0.0.1:8787/docs` | Rendered operations docs |
| `http://127.0.0.1:8787/healthz` | Health probe |
| `http://127.0.0.1:8787/v1/models` | Available models |
| `http://127.0.0.1:8787/v1/runtime/status` | Worker/scheduler status |
| `http://127.0.0.1:8787/metrics` | Prometheus metrics |

## Which method should I choose?

- Choose **GHCR Docker** when you want the fastest installation and simplest
  upgrade path.
- Choose **Docker Compose** when you want a repository-managed server setup.
- Choose **source mode** when you are developing or modifying AsterMux.
- Choose **macOS service mode** when AsterMux should run continuously as a local
  desktop service.

The npm package name is reserved by the project metadata, but AsterMux is not
currently published to the public npm registry. Until it is published, do not
use `npm install astermux` or `npx astermux` as an installation method.
