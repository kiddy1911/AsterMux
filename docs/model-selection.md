# Model selection in AsterMux

AsterMux does not maintain a hard-coded list of models that receive the fast
path. The model catalog belongs to the configured Cursor account and can change
without an AsterMux release.

## Discovery

`GET /v1/models` exposes the models visible to the current Cursor installation
or authenticated account. Clients should prefer this runtime catalog over a
static list copied into application code.

## Universal pool resolution

For pooled ACP requests, AsterMux deliberately starts physical workers without
binding them to a model. Each fresh session follows this sequence:

1. create an ACP session;
2. inspect the session's advertised `configOptions` / model choices;
3. match the caller's public model id to an exact Agent-advertised choice;
4. apply advertised secondary controls for reasoning/effort, fast mode,
   thinking, or context where applicable;
5. send the prompt;
6. recycle the physical worker for a future session, which may use a completely
   different model.

This is why the number of warm Cursor processes does not grow with the number of
models in `/v1/models`.

## Default model

`ASTERMUX_DEFAULT_MODEL` is only a fallback for requests that omit a model or use
the gateway's default convention. It is not the identity of the worker pool and
does not receive a privileged optimization path.

## Strict matching

With the recommended setting:

```env
ASTERMUX_STRICT_MODEL=true
```

AsterMux returns a deterministic model-selection error when the requested id
cannot be matched to the current Cursor catalog. It does not silently run an
unrelated session-default model.

## Model variants

Cursor may expose multiple public ids that correspond to one underlying model
plus settings such as reasoning effort, fast mode, thinking, or context size.
AsterMux maps these only to values that the ACP session actually advertises. It
does not fabricate model configuration values from a model-family table.

As a result, new Cursor model families can normally use the same execution path
without source changes, provided the installed Cursor Agent exposes them
through the standard session configuration mechanism.

## Performance expectations

AsterMux can make gateway overhead consistent across models; it cannot make the
models themselves equally fast. Inference latency, context limits, availability,
quota, and tool quality still depend on the selected upstream model and Cursor
account.
