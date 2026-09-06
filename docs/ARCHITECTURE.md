# AsterMux architecture

AsterMux is an adaptive compatibility gateway around Cursor's ACP-capable agent.
Its public surface speaks OpenAI Chat Completions, OpenAI Responses, Anthropic
Messages, health/status, batch, and metrics APIs. Its execution plane is built
around persistent ACP workers rather than one CLI process per HTTP request.

## Execution plane

```text
HTTP client
   |
   +-- OpenAI / Responses / Anthropic adapters
   |
   +-- request classifier
          |
          +-- interactive lane ---- universal ACP pool
          +-- batch lane ---------- universal ACP pool
          +-- external tools ------ stateless Tool ACP pool
                                      |
                                      +-- temporary MCP server

Each fresh ACP session selects the requested model from the Agent-advertised
config options. Physical workers are not keyed by model.
```

## Core invariants

1. **Model-agnostic workers.** Model identity belongs to an ACP session, not a
   long-lived process. New Cursor models do not require new pools or source-code
   allowlists.
2. **Bounded concurrency.** Interactive, batch, and Tool execution have explicit
   ceilings and queues. The gateway never creates unbounded Cursor processes.
3. **Elastic memory.** Each lane can keep a warm floor smaller than its maximum
   ceiling, scale on demand, then retire excess workers after an idle TTL.
4. **Stateless external tools by default.** Chat/Anthropic tool turns reconstruct
   state from caller history, avoiding parked-session ownership bottlenecks.
5. **Protocol-specific compatibility.** OpenAI, Responses, and Anthropic shapes
   are translated at the edge; ACP remains the internal execution protocol.
6. **Isolation first.** Chat-only mode uses an isolated workspace and sanitized
   runtime environment unless an operator explicitly enables real-workspace
   execution.

## Memory profiles

`*_POOL_SIZE` is the physical ceiling. `*_WARM_SIZE` is the idle floor. Keeping
warm equal to max gives the lowest burst latency. Lowering warm floors reduces
idle RSS while retaining the configured ceiling, at the cost of one-time worker
warm-up after shrink.

## Observability

`/v1/runtime/status` and `/metrics` expose current workers, warm floors, ceilings,
queue depth, queue wait, execution time, Tool state, and structured-output repair
statistics. AsterMux-owned response metadata uses `X-AsterMux-*` headers.

## Source domains

```text
src/acp/          ACP transport, universal pools, Tool turns
src/gateway/      HTTP server, router, config, workspace, local console
src/provider/     Cursor Agent execution, model/account resolution
src/protocols/    OpenAI, Responses, Anthropic, structured Tool translation
src/runtime/      subprocess, streaming, disconnect, Windows primitives
src/scheduling/   persistent asynchronous batch scheduling
src/sdk/          published JavaScript client
src/entry/        executable entry points
src/commands/     CLI command implementations
```
