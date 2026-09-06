# Operating AsterMux

This guide covers the local dashboard, launcher, macOS service integration,
account directories, logs, and common recovery steps.

## Local control surface

With AsterMux running on the default address:

| URL | Purpose |
|---|---|
| `http://127.0.0.1:8765/` | Runtime dashboard |
| `http://127.0.0.1:8765/docs` | Rendered operations guide |
| `http://127.0.0.1:8765/healthz` | Minimal health probe |
| `http://127.0.0.1:8765/health` | JSON health/config summary |
| `http://127.0.0.1:8765/v1/runtime/status` | Scheduler and pool state |
| `http://127.0.0.1:8765/metrics` | Prometheus metrics |

The dashboard should remain on loopback unless you deliberately place it behind
an authenticated/trusted network boundary.

## Launcher

The repository ships `scripts/astermux`, a local process/service helper. Install
it as a symlink:

```bash
chmod +x scripts/astermux
mkdir -p ~/.local/bin
ln -sf "$(pwd)/scripts/astermux" ~/.local/bin/astermux
export ASTERMUX_ROOT="$(pwd)"
```

Common commands:

| Command | Action |
|---|---|
| `astermux start` | Start the compiled Node gateway in the background. |
| `astermux stop` | Graceful stop, then forced termination if necessary. |
| `astermux restart` | Restart the gateway. |
| `astermux health` | Show PID/service state and probe `/healthz`. |
| `astermux requests` | Read the completed-request log. |
| `astermux requests --watch` | Continuously follow request summaries. |
| `astermux run` | Run the gateway in the foreground. |
| `astermux enable` | Install/load the macOS launchd service. |
| `astermux disable` | Unload/remove the macOS launchd service. |

Launcher state lives under `~/.astermux/` by default.

## macOS launchd

`astermux enable` installs a user LaunchAgent with label:

```text
io.astermux.gateway
```

If KeepAlive is enabled, disable the LaunchAgent before expecting a manual stop
to remain stopped:

```bash
astermux disable
astermux stop
```

The optional menu-bar app is under `apps/macos-menu/` and uses the separate
label `io.astermux.widget`.

## Account directories

AsterMux can rotate across multiple Cursor configuration directories. Managed
accounts default to:

```text
~/.astermux/accounts/
```

Or provide explicit directories:

```env
ASTERMUX_ACCOUNT_DIRS=/srv/accounts/a,/srv/accounts/b
```

`ASTERMUX_MULTI_PORT=true` starts one server per configured account on
incrementing ports beginning at `ASTERMUX_PORT`.

## Logs and state

| Path | Purpose |
|---|---|
| `~/.astermux/sessions.log` | Default completed-request log. |
| `~/.astermux/gateway.log` | Launcher-managed background stdout/stderr. |
| `~/.astermux/gateway.pid` | Launcher/process PID state. |
| `data/batches/` | Persistent asynchronous batch state when enabled. |

The exact log/state paths can be overridden through configuration.

## Runtime status

`GET /v1/runtime/status` reports the execution planes independently. Important
fields include:

- interactive and batch `workers`, `poolSize`, `warmSize`, `active`, and queue
  counters;
- Tool pool `workers`, `poolSize`, `warmSize`, `busy`, `idle`, and `queued`;
- parked Tool-session counts for explicit stateful mode;
- structured-output first-pass / repair counters.

During elastic operation, `workers < poolSize` while idle is expected. A burst
causes workers to grow toward the ceiling, then `ASTERMUX_ACP_ELASTIC_IDLE_MS`
shrinks excess idle workers back to the configured warm floor.

## Reverse proxy timeouts

Long reasoning and structured-output requests can exceed common HTTP defaults.
For Nginx, a practical starting point is:

```nginx
proxy_connect_timeout 30s;
proxy_send_timeout 300s;
proxy_read_timeout 300s;
```

Streaming clients must also avoid response buffering at intermediate proxies.

## Troubleshooting

### Gateway is healthy but a model request fails

Confirm the model is present in `/v1/models`. With `ASTERMUX_STRICT_MODEL=true`,
AsterMux rejects ids that cannot be mapped to the Cursor CLI/ACP catalog.

### Tool call returns queue timeout

Inspect `tool_pool` in `/v1/runtime/status`. If `busy == poolSize` and `queued`
rises, either increase the Tool ceiling on a host with memory headroom or tune
the Tool queue timeout. Do not create unbounded workers.

### First burst is slower after a long idle period

This is expected only when warm floors are below ceilings. The first requests
may wait for elastic workers to initialize. Once scaled, steady-state execution
uses the full configured ceiling.

### Memory is too high on a small host

Reduce warm floors first. If the machine cannot safely hold the full ceiling at
peak, reduce `*_POOL_SIZE` as well. The validated 1 GiB profile in the README is
a conservative reference point.

### Windows long-prompt failures

Prefer ACP or stdin prompt delivery. `ASTERMUX_WIN_CMDLINE_MAX` controls the
legacy CreateProcess budget when argv delivery is unavoidable.

### Dashboard action says CLI is missing

Install/symlink `scripts/astermux` to `~/.local/bin/astermux` or configure
`ASTERMUX_WIDGET_CLI` for the menu-bar app.
