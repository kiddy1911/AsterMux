# Contributing to AsterMux

Thanks for contributing. AsterMux is an execution gateway, so changes to model
selection, tool lifecycles, scheduling, and process management should preserve
bounded resource usage and protocol compatibility.

## Development

```bash
npm ci
npm run typecheck
npm test -- --run
npm run build
```

Docker changes should also pass:

```bash
docker build -t astermux:dev .
docker compose -f compose.yaml config --quiet
```

## Pull requests

Keep changes focused and include tests for behavioral changes. In particular:

- new model handling should remain data-driven from the Cursor/ACP catalog;
- worker creation must remain bounded by configured ceilings;
- external Tool changes must preserve caller-owned stateless reconstruction;
- compatibility changes should identify the affected API surface;
- low-memory changes should report both memory effect and latency/throughput cost.

## Security and privacy

Never commit or paste:

- `.env`;
- `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, or `ASTERMUX_API_KEY` values;
- Cursor account directories;
- migration archives containing credentials;
- private request bodies or workspace contents.

Use `.env.example` for configuration documentation. Report security issues using
GitHub private security advisories once the public repository is available.
