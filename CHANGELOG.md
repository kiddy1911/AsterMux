# Changelog

## 0.1.2

- Added professional project metadata, README status badges, support/community documentation, and MIT package metadata.
- Added CodeQL scanning, Dependabot, CODEOWNERS, pull-request guidance, EditorConfig, and Git attributes.
- Consolidated release automation so releases publish only after a successful main-branch CI run, with GHCR provenance/SBOM metadata.
- Raised the source/runtime support baseline to Node.js 22.12+ and validate Node 22/24 in CI.

## 0.1.1

- Changed the default AsterMux HTTP port from `8765` to `8787` across runtime, Docker, SDK, examples, and documentation.
- Kept legal notices out of the product-facing README while retaining required distribution files.

## 0.1.0

Initial AsterMux public release.

### Highlights

- Model-agnostic Universal ACP Pool with per-session model selection.
- OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages surfaces.
- Stateless external Tool turns with bounded warm Tool workers.
- Dual interactive/batch scheduling lanes with queue limits and observability.
- Elastic ACP warm floors for substantially lower idle memory on small hosts.
- Structured-output validation and bounded repair path.
- Persistent asynchronous batch API.
- Local dashboard, rendered operations docs, Prometheus metrics, and runtime status.
- Validated low-memory profile for a 1 vCPU / 1 GiB container.
