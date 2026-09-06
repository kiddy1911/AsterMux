# AsterMux examples

Examples are grouped by how an application integrates with AsterMux.

## SDK

### Minimal AsterMux client

```bash
node examples/sdk/basic-client.mjs
```

Uses `createAsterMuxClient()` and demonstrates SDK-managed startup.

### OpenAI SDK

Install the OpenAI client if it is not already present:

```bash
npm install openai
node examples/sdk/openai-sdk.mjs
```

The OpenAI SDK points at AsterMux while model execution is handled by Cursor ACP.

### Streaming through the AsterMux SDK

```bash
node examples/sdk/streaming.mjs
```

Shows SSE consumption from `/v1/chat/completions`.

## Raw HTTP

Start AsterMux first:

```bash
npm start
```

Then run either example:

```bash
node examples/raw-http/chat.mjs
node examples/raw-http/streaming.mjs
```

Set `ASTERMUX_URL` when the gateway is not on the default
`http://127.0.0.1:8765` address.

## Benchmark harness

```bash
npm run build
node examples/benchmarks/latency.mjs
```

The harness separates process/setup time from model execution and can compare
ordinary CLI, pooled ACP, and Tool paths. Useful environment controls include:

```text
ASTERMUX_URL
ASTERMUX_API_KEY
BENCH_MODEL
BENCH_PROMPT
BENCH_SKIP_EPHEMERAL
BENCH_COMPARE_AGENT
BENCH_MAX_MODE
```

Benchmark results depend on Cursor account, model availability, host resources,
and upstream model latency. Treat them as local measurements rather than
portable guarantees.
