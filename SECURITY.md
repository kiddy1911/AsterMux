# Security policy

## Supported releases

Security fixes are applied to the latest published AsterMux release.

## Reporting a vulnerability

When the public repository is created, use GitHub's private security-advisory
workflow for vulnerability reports. Do not open a public issue containing API
keys, authentication tokens, request bodies, account directories, or private
workspace paths.

## Deployment boundary

AsterMux is a network-facing gateway. Bind to loopback by default, configure
`ASTERMUX_API_KEY` before exposing it beyond the host, and terminate TLS at a
trusted reverse proxy or with AsterMux TLS configuration. `CURSOR_API_KEY` is an
upstream Cursor credential and must never be committed to the repository.
