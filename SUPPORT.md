# Support

## Start here

Before opening an issue, check:

- [Running AsterMux](docs/RUNNING.md) for installation, Docker, Compose, source,
  macOS service, upgrades, and health checks.
- [Configuration reference](docs/CONFIGURATION.md) for environment variables.
- [Operations](docs/OPERATIONS.md) for logs, runtime status, reverse-proxy
  settings, and troubleshooting.
- [Model selection](docs/model-selection.md) for model-resolution behavior.

## Bugs

Use the GitHub **Bug report** issue form and include:

- AsterMux version or commit;
- Cursor Agent version;
- operating system / container runtime;
- a minimal reproduction;
- sanitized logs and the relevant HTTP status/error.

Never include `.env` contents, API keys, authentication tokens, private request
bodies, or private workspace data.

## Feature requests

Use the **Feature request** issue form. Describe the use case and compatibility
surface involved (OpenAI, Responses, Anthropic, ACP, MCP, Tool calls, batching,
or deployment).

## Setup and usage questions

Use the **Support question** issue form after checking the running and
configuration docs. Include what you already tried and sanitized diagnostics.

## Security vulnerabilities

Do **not** use public issues. Follow [SECURITY.md](SECURITY.md) and report the
problem through GitHub's private security-advisory workflow.
