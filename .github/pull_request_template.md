## Summary

Describe what changed and why.

## Validation

Describe the commands/tests run and the relevant results.

## Compatibility / operational impact

Note any effect on API compatibility, model selection, Tool lifecycle, worker
ceilings, memory, latency, Docker, or configuration. Write `None` when there is
no impact.

## Checklist

- [ ] I did not include `.env`, API keys, auth tokens, account data, or private logs.
- [ ] Behavioral changes include appropriate tests.
- [ ] `npm run typecheck` and `npm test` pass where applicable.
- [ ] User-facing configuration/behavior changes include documentation.
- [ ] Worker/process creation remains bounded by configured limits.
- [ ] I updated `CHANGELOG.md` when this changes a published user-facing behavior.
