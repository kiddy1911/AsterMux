# AsterMux configuration reference

AsterMux-owned settings use the `ASTERMUX_*` namespace. `CURSOR_*` variables in
this document configure the external Cursor runtime rather than AsterMux itself.

## Network and authentication

| Variable | Default | Purpose |
|---|---:|---|
| `ASTERMUX_HOST` | `127.0.0.1` | Process bind address. |
| `ASTERMUX_PORT` | `8765` | Process listen port. |
| `ASTERMUX_API_KEY` | unset | Require `Authorization: Bearer ...` on LLM API routes. |
| `ASTERMUX_TLS_CERT` | unset | TLS certificate path. Use together with `ASTERMUX_TLS_KEY`. |
| `ASTERMUX_TLS_KEY` | unset | TLS private-key path. |
| `ASTERMUX_SESSIONS_LOG` | `~/.astermux/sessions.log` | Completed-request log. |
| `ASTERMUX_VERBOSE` | `false` | Log full request/response content. Sensitive in production. |

Docker Compose additionally accepts:

| Variable | Default | Purpose |
|---|---:|---|
| `ASTERMUX_BIND_ADDR` | `127.0.0.1` | Host-side address used by Docker port publishing. |
| `ASTERMUX_PUBLISH_PORT` | `8765` | Host-side published port. |

## Cursor runtime

| Variable | Default | Purpose |
|---|---:|---|
| `CURSOR_API_KEY` | unset | Headless Cursor credential passed to Agent/ACP children. |
| `CURSOR_AUTH_TOKEN` | unset | Alternate Cursor credential name accepted by the runtime. |
| `CURSOR_AGENT_BIN` | auto | Explicit Cursor Agent executable. |
| `CURSOR_CLI_BIN` / `CURSOR_CLI_PATH` | auto | Additional executable aliases used during Agent discovery. |
| `CURSOR_AGENT_NODE` | unset | Windows Node executable for direct script invocation. |
| `CURSOR_AGENT_SCRIPT` | unset | Windows Agent entry script used with `CURSOR_AGENT_NODE`. |

## Request behavior

| Variable | Default | Purpose |
|---|---:|---|
| `ASTERMUX_DEFAULT_MODEL` | `auto` | Model used only when the request does not specify one. |
| `ASTERMUX_STRICT_MODEL` | `true` | Reject model ids absent from Cursor CLI/ACP catalogs. |
| `ASTERMUX_TIMEOUT_MS` | `300000` | Completion execution timeout in milliseconds. |
| `ASTERMUX_MODE` | `ask` effective default | Cursor execution mode: `ask`, `agent`, or `plan`. |
| `ASTERMUX_FORCE` | `false` | Forward Cursor's force option. |
| `ASTERMUX_APPROVE_MCPS` | `false` | Forward Cursor's MCP approval option. |
| `ASTERMUX_MAX_MODE` | `false` | Enable Cursor Max Mode where supported. |
| `ASTERMUX_PROMPT_VIA_STDIN` | `false` | Send legacy CLI prompts through stdin instead of argv. |
| `ASTERMUX_WIN_CMDLINE_MAX` | `30000` | Windows CreateProcess command-line budget. |

Per-request AsterMux controls use headers such as `X-AsterMux-Mode`,
`X-AsterMux-Workspace`, `X-AsterMux-Tool-Mode`, `X-AsterMux-Client`, and
`X-AsterMux-Invoke-From`.

## Workspace isolation

| Variable | Default | Purpose |
|---|---:|---|
| `ASTERMUX_WORKSPACE` | process cwd | Root allowed for real-workspace execution. |
| `ASTERMUX_CHAT_ONLY_WORKSPACE` | `true` | Use an isolated temporary workspace for ordinary chat. |
| `ASTERMUX_CONTEXT_PREAMBLE` | `true` | Add a short factual gateway/workspace preamble to the Agent prompt. |
| `ASTERMUX_CONTEXT_EXTRA` | unset | Optional operator note, capped at 400 characters. Do not place secrets here. |

When real-workspace mode is enabled, `X-AsterMux-Workspace` must resolve beneath
`ASTERMUX_WORKSPACE`.

## ACP execution pools

| Variable | Default | Purpose |
|---|---:|---|
| `ASTERMUX_USE_ACP` | `false` | Use Cursor ACP over stdio. Required for universal pooling and external tools. |
| `ASTERMUX_ACP_POOL_SIZE` | `0` | Interactive physical-worker ceiling. |
| `ASTERMUX_ACP_BATCH_POOL_SIZE` | `0` in runtime | Batch/structured-output physical-worker ceiling. Compose may provide a higher default. |
| `ASTERMUX_ACP_INTERACTIVE_WARM_SIZE` | `-1` | Interactive idle floor; `-1` means warm all configured workers. |
| `ASTERMUX_ACP_BATCH_WARM_SIZE` | `-1` | Batch idle floor. |
| `ASTERMUX_ACP_ELASTIC_IDLE_MS` | `120000` | Idle time before excess elastic workers retire. `0` disables shrink. |
| `ASTERMUX_ACP_INTERACTIVE_QUEUE_MAX` | `4` | Maximum waiting interactive requests. |
| `ASTERMUX_ACP_BATCH_QUEUE_MAX` | `12` runtime default | Maximum waiting batch requests. |
| `ASTERMUX_ACP_INTERACTIVE_QUEUE_TIMEOUT_MS` | `15000` | Interactive queue timeout. |
| `ASTERMUX_ACP_BATCH_QUEUE_TIMEOUT_MS` | `30000` runtime default | Batch queue timeout. |
| `ASTERMUX_ACP_POOL_MAX_REQUESTS` | `100` | Recycle a persistent worker after this many completed requests. |
| `ASTERMUX_ACP_POOL_MAX_AGE_MS` | `3600000` | Recycle a persistent worker after this age. |
| `ASTERMUX_ACP_SKIP_AUTHENTICATE` | auto | Skip ACP authenticate when the environment is already authenticated. |
| `ASTERMUX_ACP_RAW_DEBUG` | `false` | Log raw ACP JSON-RPC when debug logging is enabled. |

Set `NODE_DEBUG=astermux:acp` for ACP debug output.

## External Tool execution

| Variable | Default | Purpose |
|---|---:|---|
| `ASTERMUX_TOOL_SESSION_MODE` | `stateless` | Chat/Anthropic Tool lifecycle: `stateless` or `stateful`. |
| `ASTERMUX_ACP_TOOL_POOL_SIZE` | `0` | Tool physical-worker ceiling. |
| `ASTERMUX_ACP_TOOL_WARM_SIZE` | `-1` | Tool idle floor; `-1` means warm all. |
| `ASTERMUX_ACP_TOOL_QUEUE_MAX` | `8` | Maximum waiting stateless Tool turns. |
| `ASTERMUX_ACP_TOOL_QUEUE_TIMEOUT_MS` | `120000` | Tool queue timeout. |
| `ASTERMUX_TOOL_SESSION_TTL_MS` | `60000` | Parked-session TTL for stateful legacy turns. |
| `ASTERMUX_TOOL_SESSION_MAX_PER_OWNER` | `4` | Per-owner parked-session cap in stateful mode. |
| `ASTERMUX_TOOL_SESSION_MAX_GLOBAL` | `16` | Global parked-session cap in stateful mode. |

## Structured output and repair

| Variable | Default | Purpose |
|---|---:|---|
| `ASTERMUX_STATELESS_TOOL_NAMES` | empty | Comma-separated output-tool names routed through the one-shot structured path. |
| `ASTERMUX_STATELESS_REPAIR_RETRIES` | `1` | Bounded format-repair retries after schema-invalid output. |

## Persistent batches

| Variable | Default | Purpose |
|---|---:|---|
| `ASTERMUX_BATCH_ENABLED` | `false` | Enable persistent asynchronous batch jobs. |
| `ASTERMUX_BATCH_DIR` | `data/batches` | Batch state directory. Compose uses `/app/data/batches`. |
| `ASTERMUX_BATCH_CONCURRENCY` | `8` | Maximum concurrently executing batch items. |
| `ASTERMUX_BATCH_MAX_REQUESTS` | `1000` | Maximum items accepted in one batch. |
| `ASTERMUX_BATCH_MAX_JOBS` | `100` | Maximum retained job records. |
| `ASTERMUX_BATCH_RETENTION_MS` | `259200000` | Terminal-job retention window. |

## Account rotation and multi-port

| Variable | Default | Purpose |
|---|---:|---|
| `ASTERMUX_ACCOUNT_DIRS` | auto-discover | Comma-separated Cursor configuration directories for account rotation. |
| `ASTERMUX_MULTI_PORT` | `false` | Run one server per account directory on incrementing ports. |

Without `ASTERMUX_ACCOUNT_DIRS`, AsterMux searches `~/.astermux/accounts/` for
managed account directories.

## Harness mode markers

These are optional integration hooks and are not needed for normal use:

| Variable | Default | Purpose |
|---|---:|---|
| `ASTERMUX_DSH_AUTO_MODE` | `false` | Select plan/agent mode from trusted DeepSeek Harness system markers. |
| `ASTERMUX_DSH_SYSTEM_MARKER` | built-in marker | Identifies DSH-owned system/developer content. |
| `ASTERMUX_DSH_PLAN_MARKER` | built-in marker | Identifies DSH plan-mode content. |

## SDK-only settings

| Variable | Default | Purpose |
|---|---:|---|
| `ASTERMUX_URL` | `http://127.0.0.1:8765` | Base URL used by the JavaScript SDK helpers. |

The launcher also understands `ASTERMUX_ROOT` and `ASTERMUX_NODE`; the optional
macOS menu app uses `ASTERMUX_WIDGET_CLI` and `ASTERMUX_WIDGET_INTERVAL`.
