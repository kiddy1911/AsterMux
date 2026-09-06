import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { GatewayConfig } from "../../gateway/config.js";
import type { CursorExecutionMode } from "../../provider/execution-mode.js";
import type { ModelCacheRef } from "./model-list.js";
import { getCachedCursorModels } from "./model-list.js";
import { buildAgentFixedArgs } from "../../provider/invocation.js";
import {
  runAgentStream,
  runAgentSync,
  startAgentToolSession,
} from "../../provider/executor.js";
import type {
  AcpToolSession,
  ToolTurnEvent,
  ToolTurnResult,
} from "../../acp/tool-turn.js";
import { ToolAcpQueueError } from "../../acp/tool-pool.js";
import { AcpPoolQueueError, type AcpPoolLane } from "../../acp/execution-pool.js";
import { createStreamParser } from "../../runtime/stream-parser.js";
import { json, writeSseHeaders } from "../../gateway/http.js";
import {
  resolveModelForExecution,
  UnsupportedReasoningEffortError,
} from "../../provider/model-catalog.js";
import {
  buildPromptFromMessages,
  normalizeModelId,
  toolsToSystemText,
  type OpenAiChatCompletionRequest,
} from "../openai.js";
import {
  logAgentError,
  logAccountAssigned,
  logAccountStats,
  logModelResolution,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../../gateway/request-log.js";
import { rememberResolvedModel, resolveModel } from "../../provider/model-resolution.js";
import { resolveRequestMode } from "../../provider/mode-resolution.js";
import { resolveWorkspace } from "../../gateway/workspace.js";
import { buildGatewayContext, GATEWAY_PROMPT_SEPARATOR } from "../../gateway/prompt-context.js";
import { sanitizeMessages } from "../../gateway/sanitize.js";
import {
  getNextAccountConfigDir,
  reportRequestStart,
  reportRequestEnd,
  reportRateLimit,
  reportRequestSuccess,
  reportRequestError,
  getAccountStats,
} from "../../provider/accounts.js";
import { abortOnClientDisconnect } from "../../runtime/disconnect.js";
import {
  compactJsonPayloadText,
  parseStatelessToolArguments,
  recordStatelessFailure,
  recordStatelessFirstPass,
  recordStatelessRepairAttempt,
  recordStatelessRepairCompleted,
  statelessToolInstruction,
  statelessToolRepairPrompt,
} from "../structured-output.js";
import {
  fitPromptToWinCmdline,
  warnPromptTruncated,
} from "../../runtime/windows-command-line.js";
import {
  chatToolOutputs,
  parseOpenAiFunctionTools,
  resolveToolChoice,
  type PendingClientToolCall,
} from "../tools.js";
import {
  ToolSessionError,
  toolSessionOwnerKey,
  type ToolSessionRecord,
  type ToolSessionReservation,
  type ToolSessionRegistry,
} from "../../acp/stateful-turn-registry.js";

function isRateLimited(stderr: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(stderr);
}

export type ChatCompletionsCtx = {
  config: GatewayConfig;
  lastRequestedModelRef: { current?: string };
  modelCacheRef: ModelCacheRef;
  toolSessions: ToolSessionRegistry;
};

function chatToolCallWire(calls: readonly PendingClientToolCall[]) {
  return calls.map((call) => ({
    id: call.callId,
    type: "function" as const,
    function: { name: call.name, arguments: call.arguments },
  }));
}

function chatToolResponse(opts: {
  id: string;
  created: number;
  model: string | undefined;
  result: ToolTurnResult;
  promptLength: number;
}) {
  const completionText = opts.result.text;
  const promptTokens = Math.max(1, Math.round(opts.promptLength / 4));
  const completionTokens = Math.max(
    1,
    Math.round(completionText.length / 4),
  );
  const calls =
    opts.result.status === "tool_calls"
      ? chatToolCallWire(opts.result.toolCalls)
      : undefined;
  return {
    id: opts.id,
    object: "chat.completion",
    created: opts.created,
    model: opts.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: completionText || (calls ? null : ""),
          ...(opts.result.reasoning
            ? { reasoning_content: opts.result.reasoning }
            : {}),
          ...(calls ? { tool_calls: calls } : {}),
        },
        finish_reason: calls ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function writeStructuredChatTurn(opts: {
  res: http.ServerResponse;
  stream: boolean;
  id: string;
  created: number;
  model: string | undefined;
  promptLength: number;
  run: (
    listener?: (event: ToolTurnEvent) => void,
  ) => Promise<ToolTurnResult>;
}): Promise<ToolTurnResult> {
  if (!opts.stream) {
    const result = await opts.run();
    json(
      opts.res,
      200,
      chatToolResponse({
        id: opts.id,
        created: opts.created,
        model: opts.model,
        result,
        promptLength: opts.promptLength,
      }),
    );
    return result;
  }

  writeSseHeaders(opts.res);
  const writeChunk = (
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    usage?: Record<string, number>,
  ) => {
    opts.res.write(
      `data: ${JSON.stringify({
        id: opts.id,
        object: "chat.completion.chunk",
        created: opts.created,
        model: opts.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      })}\n\n`,
    );
  };
  writeChunk({ role: "assistant" });
  let emittedText = "";
  let emittedReasoning = "";
  const result = await opts.run((event) => {
    if (event.type === "text") {
      emittedText += event.text;
      writeChunk({ content: event.text });
    } else {
      emittedReasoning += event.text;
      writeChunk({ reasoning_content: event.text });
    }
  });
  if (result.reasoning.length > emittedReasoning.length) {
    writeChunk({
      reasoning_content: result.reasoning.slice(emittedReasoning.length),
    });
  }
  if (result.text.length > emittedText.length) {
    writeChunk({ content: result.text.slice(emittedText.length) });
  }
  if (result.status === "tool_calls") {
    result.toolCalls.forEach((call, index) => {
      writeChunk({
        tool_calls: [
          {
            index,
            id: call.callId,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          },
        ],
      });
    });
  }
  const promptTokens = Math.max(1, Math.round(opts.promptLength / 4));
  const completionTokens = Math.max(1, Math.round(result.text.length / 4));
  writeChunk(
    {},
    result.status === "tool_calls" ? "tool_calls" : "stop",
    {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  );
  opts.res.write("data: [DONE]\n\n");
  opts.res.end();
  return result;
}

export async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ChatCompletionsCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const { config, lastRequestedModelRef, modelCacheRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as OpenAiChatCompletionRequest;
  let selectedTools;
  let toolInstruction: string | undefined;
  let requireToolCall = false;
  let maxParallelToolCalls: number | undefined;
  let submittedToolOutputs;
  try {
    const parsedTools = parseOpenAiFunctionTools(body.tools, body.functions);
    const choice = resolveToolChoice(
      parsedTools,
      body.tool_choice ?? body.function_call,
      {
      parallelToolCalls: (body as any).parallel_tool_calls,
      },
    );
    selectedTools = choice.tools;
    toolInstruction = choice.instruction;
    requireToolCall = choice.required;
    maxParallelToolCalls = choice.maxParallelToolCalls;
    submittedToolOutputs = chatToolOutputs(body.messages ?? []);
  } catch (error) {
    json(res, 400, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: "invalid_tools",
        type: "invalid_request_error",
      },
    });
    return;
  }
  const ownerKey = toolSessionOwnerKey(req, remoteAddress);
  const requested = normalizeModelId(body.model);
  const model = resolveModel(requested, lastRequestedModelRef, config);
  const models = await getCachedCursorModels(config, modelCacheRef);
  let decision;
  try {
    decision = resolveModelForExecution({
      requested: model,
      defaultModel: config.defaultModel,
      availableCursorIds: models.map((m) => m.id),
      reasoningEffort: body.reasoning_effort,
    });
  } catch (error) {
    if (!(error instanceof UnsupportedReasoningEffortError)) throw error;
    json(res, 400, {
      error: {
        message: error.message,
        code: error.code,
        type: "invalid_request_error",
      },
    });
    return;
  }
  const cursorModel = decision.final;
  rememberResolvedModel(cursorModel, lastRequestedModelRef);
  logModelResolution(config.verbose, decision);
  // When request is "default", use defaultModel for response display (dashboard) if set; else echo "default"
  const displayModel =
    decision.requestedWasDefault && config.defaultModel !== "default"
      ? config.defaultModel
      : model;
  const modelCatalogName = models.find(
    (item) => item.id === cursorModel,
  )?.name;
  const id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  const cleanMessages = sanitizeMessages(body.messages ?? []);

  const toolModeHeaderRaw = req.headers["x-astermux-tool-mode"];
  const toolModeHeader = (Array.isArray(toolModeHeaderRaw)
    ? toolModeHeaderRaw[0]
    : toolModeHeaderRaw
  )?.trim().toLowerCase();
  const poolLaneHeaderRaw = req.headers["x-astermux-pool-lane"];
  const poolLaneHeader = (Array.isArray(poolLaneHeaderRaw)
    ? poolLaneHeaderRaw[0]
    : poolLaneHeaderRaw
  )?.trim().toLowerCase();
  const statelessTool = selectedTools.length === 1 ? selectedTools[0] : undefined;
  const statelessToolStart =
    config.useAcp &&
    !body.stream &&
    statelessTool !== undefined &&
    submittedToolOutputs.length === 0 &&
    (toolModeHeader === "stateless" ||
      (toolModeHeader !== "stateful" &&
        (config.statelessToolNames ?? []).includes(statelessTool.name)));
  const statelessExternalToolMode =
    config.useAcp &&
    !statelessToolStart &&
    selectedTools.length > 0 &&
    (toolModeHeader === "stateless" ||
      (toolModeHeader !== "stateful" &&
        (config.toolSessionMode ?? "stateless") === "stateless"));
  const poolLane: AcpPoolLane =
    statelessToolStart || poolLaneHeader === "batch" ? "batch" : "interactive";
  const structuredToolStart =
    config.useAcp &&
    !statelessToolStart &&
    selectedTools.length > 0 &&
    (statelessExternalToolMode || submittedToolOutputs.length === 0);
  const toolsText = structuredToolStart || statelessToolStart
    ? undefined
    : body.tool_choice === "none"
      ? undefined
      : toolsToSystemText(body.tools, body.functions);
  let promptCompacted = false;
  const promptMessages = statelessToolStart
    ? cleanMessages.map((message: any) => {
        if (typeof message?.content !== "string") return message;
        const compact = compactJsonPayloadText(message.content);
        if (compact !== message.content) promptCompacted = true;
        return compact === message.content ? message : { ...message, content: compact };
      })
    : cleanMessages;
  const messagesWithTools = [
    ...(statelessToolStart && statelessTool
      ? [{ role: "system", content: statelessToolInstruction(statelessTool) }]
      : toolInstruction && structuredToolStart
        ? [{ role: "system", content: toolInstruction }]
        : []),
    ...(toolsText ? [{ role: "system", content: toolsText }] : []),
    ...promptMessages,
  ];
  const prompt = buildPromptFromMessages(messagesWithTools);

  const trafficMessages: TrafficMessage[] = cleanMessages.map((m: any) => {
    const content =
      typeof m?.content === "string"
        ? m.content
        : Array.isArray(m?.content)
          ? (m.content as Array<{ type?: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("")
          : "";
    return { role: String(m?.role ?? "user"), content };
  });
  logTrafficRequest(
    config.verbose,
    model ?? cursorModel,
    trafficMessages,
    !!body.stream,
  );

  if (
    config.useAcp &&
    !statelessExternalToolMode &&
    submittedToolOutputs.length > 0
  ) {
    const record = ctx.toolSessions.findByCallIds(
      "chat",
      ownerKey,
      submittedToolOutputs.map((output) => output.callId),
    );
    if (!record) {
      json(res, 409, {
        error: {
          message:
            "Tool session is missing or expired; restart the conversation",
          code: "tool_session_expired",
          type: "invalid_request_error",
        },
      });
      return;
    }
    const configDir = record.configDir;
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const startedAt = Date.now();
    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);
    abortController.signal.addEventListener(
      "abort",
      () => void record.session.close(),
      { once: true },
    );
    try {
      const result = await writeStructuredChatTurn({
        res,
        stream: !!body.stream,
        id,
        created,
        model: displayModel,
        promptLength: prompt.length,
        run: (listener) =>
          ctx.toolSessions.resume(record, submittedToolOutputs, listener),
      });
      reportRequestSuccess(configDir, Date.now() - startedAt);
      logTrafficResponse(
        config.verbose,
        model ?? cursorModel,
        result.text,
        !!body.stream,
      );
    } catch (error) {
      reportRequestError(configDir, Date.now() - startedAt);
      if (!res.headersSent) {
        json(res, error instanceof ToolSessionError ? error.status : 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            code:
              error instanceof ToolSessionError
                ? error.code
                : "tool_session_error",
          },
        });
      } else if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
              code: "tool_session_error",
            },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } finally {
      reportRequestEnd(configDir);
      logAccountStats(config.verbose, getAccountStats());
    }
    return;
  }

  let mode: CursorExecutionMode;
  try {
    mode = resolveRequestMode(
      config,
      req.headers["x-astermux-mode"],
      body.mode,
      body.messages,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid mode";
    json(res, 400, { error: { message: msg, code: "invalid_mode" } });
    return;
  }

  const effectiveChatOnly =
    mode === "ask"
      ? config.chatOnlyWorkspace
      : config.chatOnlyWorkspaceExplicit && config.chatOnlyWorkspace;

  const headerWs = req.headers["x-astermux-workspace"];
  let workspaceDir: string;
  let tempDir: string | undefined;
  try {
    const ws = resolveWorkspace(config, headerWs, effectiveChatOnly);
    workspaceDir = ws.workspaceDir;
    tempDir = ws.tempDir;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid workspace";
    json(res, 400, { error: { message: msg, code: "invalid_workspace" } });
    return;
  }

  const agentPrompt = config.contextPreamble
    ? `${buildGatewayContext({
        headers: req.headers,
        bridgeWorkspaceBase: config.workspace,
        agentWorkspaceDir: workspaceDir,
        isolatedChatOnly: tempDir !== undefined,
        cursorMode: mode,
        contextExtra: config.contextExtra,
      })}${GATEWAY_PROMPT_SEPARATOR}${prompt}`
    : prompt;

  const fixedArgs = buildAgentFixedArgs(
    config,
    workspaceDir,
    cursorModel,
    !!body.stream,
    mode,
    effectiveChatOnly,
  );
  const fit = fitPromptToWinCmdline(config.agentBin, fixedArgs, agentPrompt, {
    maxCmdline: config.winCmdlineMax,
    platform: process.platform,
    cwd: workspaceDir,
  });
  if (!fit.ok) {
    json(res, 500, {
      error: {
        message: fit.error,
        code: "windows_cmdline_limit",
        type: "api_error",
      },
    });
    return;
  }
  if (fit.truncated) {
    warnPromptTruncated(fit.originalLength, fit.finalPromptLength);
  }
  // When the prompt is delivered via stdin (or ACP), keep it OUT of argv,
  // otherwise a long prompt still blows past the kernel ARG_MAX (spawn E2BIG
  // on Linux). fit.args appends the full prompt for the argv path only.
  const cmdArgs =
    config.promptViaStdin || config.useAcp ? fixedArgs : fit.args;

  const promptForAgent =
    config.promptViaStdin || config.useAcp ? agentPrompt : undefined;

  const truncatedHeaders = fit.truncated
    ? { "X-AsterMux-Prompt-Truncated": "true" }
    : undefined;

  if (structuredToolStart) {
    const configDir = getNextAccountConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const startedAt = Date.now();
    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);
    let record: ToolSessionRecord | undefined;
    let reservation: ToolSessionReservation | undefined;
    let session: AcpToolSession | undefined;
    let statelessTurnSucceeded = false;
    try {
      session = await startAgentToolSession({
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        prompt: agentPrompt,
        tools: selectedTools,
        tempDir,
        configDir,
        signal: abortController.signal,
        modelDisplayName: modelCatalogName,
        requireToolCall,
        maxParallelToolCalls,
        waitForToolConnection: statelessExternalToolMode,
        beforeStart: statelessExternalToolMode
          ? undefined
          : () => {
              reservation = ctx.toolSessions.reserve(ownerKey);
            },
      });
      if (!statelessExternalToolMode) {
        record = ctx.toolSessions.createRecord({
          api: "chat",
          ownerKey,
          model: displayModel ?? cursorModel,
          configDir,
          session,
          reservation,
        });
        reservation = undefined;
      }
      abortController.signal.addEventListener(
        "abort",
        () => void session!.close(),
        { once: true },
      );
      const result = await writeStructuredChatTurn({
        res,
        stream: !!body.stream,
        id,
        created,
        model: displayModel,
        promptLength: agentPrompt.length,
        run: (listener) =>
          statelessExternalToolMode
            ? session!.collect(listener)
            : ctx.toolSessions.collect(record!, listener),
      });
      statelessTurnSucceeded = true;
      reportRequestSuccess(configDir, Date.now() - startedAt);
      if (
        result.status === "completed" &&
        result.stderr &&
        isRateLimited(result.stderr)
      ) {
        reportRateLimit(configDir, 60_000);
      }
      logTrafficResponse(
        config.verbose,
        model ?? cursorModel,
        result.text,
        !!body.stream,
      );
    } catch (error) {
      if (reservation) {
        ctx.toolSessions.releaseReservation(reservation);
        reservation = undefined;
      }
      if (record) {
        ctx.toolSessions.remove(record);
        await record.session.close().catch(() => undefined);
      }
      if (statelessExternalToolMode && session) {
        await session.close().catch(() => undefined);
      }
      reportRequestError(configDir, Date.now() - startedAt);
      if (!res.headersSent) {
        const status =
          error instanceof ToolSessionError || error instanceof ToolAcpQueueError
            ? error.status
            : 500;
        const code =
          error instanceof ToolSessionError || error instanceof ToolAcpQueueError
            ? error.code
            : "tool_session_error";
        json(
          res,
          status,
          {
            error: {
              message: error instanceof Error ? error.message : String(error),
              code,
              type: status === 429 ? "rate_limit_error" : "api_error",
            },
          },
          error instanceof ToolAcpQueueError
            ? { "Retry-After": String(error.retryAfterSeconds) }
            : undefined,
        );
      } else if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
              code: "tool_session_error",
            },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } finally {
      if (statelessExternalToolMode && session && !session.closed) {
        await session
          .close({ reusableConnection: statelessTurnSucceeded })
          .catch(() => undefined);
      }
      reportRequestEnd(configDir);
      logAccountStats(config.verbose, getAccountStats());
    }
    return;
  }

  if (body.stream) {
    const configDir = getNextAccountConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const streamStart = Date.now();

    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);

    let streamStarted = false;
    const startStream = (timing?: { lane: AcpPoolLane; workerLane?: AcpPoolLane; queueWaitMs: number }) => {
      if (streamStarted || res.headersSent) return;
      streamStarted = true;
      writeSseHeaders(res, {
        ...truncatedHeaders,
        ...(timing
          ? {
              "X-AsterMux-Pool-Lane": timing.lane,
              ...(timing.workerLane
                ? { "X-AsterMux-Worker-Lane": timing.workerLane }
                : {}),
              "X-AsterMux-Queue-Wait-Ms": String(timing.queueWaitMs),
            }
          : {}),
      });
    };
    res.on("error", () => {
      /* client disconnected mid-stream */
    });

    if (config.useAcp && typeof promptForAgent === "string") {
      let accumulated = "";
      runAgentStream(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        (chunk) => {
          startStream();
          accumulated += chunk;
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: displayModel,
              choices: [
                { index: 0, delta: { content: chunk }, finish_reason: null },
              ],
            })}\n\n`,
          );
        },
        tempDir,
        promptForAgent,
        configDir,
        abortController.signal,
        modelCatalogName,
        poolLane,
        startStream,
      )
        .then(({ code, stderr: stderrOut }) => {
          const latencyMs = Date.now() - streamStart;
          reportRequestEnd(configDir);

          if (stderrOut && isRateLimited(stderrOut)) {
            reportRateLimit(configDir, 60000);
          }

          if (abortController.signal.aborted) {
            /* client disconnected — do not count as success or failure */
          } else if (code !== 0) {
            reportRequestError(configDir, latencyMs);
            const publicMsg = logAgentError(
              config.sessionsLogPath,
              method,
              pathname,
              remoteAddress,
              code,
              stderrOut,
            );
            res.write(
              `data: ${JSON.stringify({
                error: { message: publicMsg, code: "cursor_cli_error" },
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            logAccountStats(config.verbose, getAccountStats());
            res.end();
            return;
          } else {
            reportRequestSuccess(configDir, latencyMs);
          }
          logAccountStats(config.verbose, getAccountStats());
          startStream();
          logTrafficResponse(
            config.verbose,
            model ?? cursorModel,
            accumulated,
            true,
          );
          const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
          const completionTokens = Math.max(
            1,
            Math.round(accumulated.length / 4),
          );
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: displayModel,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        })
        .catch((err) => {
          reportRequestEnd(configDir);
          if (!abortController.signal.aborted) {
            reportRequestError(configDir, Date.now() - streamStart);
            if (err instanceof AcpPoolQueueError && !res.headersSent) {
              json(
                res,
                err.status,
                {
                  error: {
                    message: err.message,
                    code: err.code,
                    type: "rate_limit_error",
                  },
                },
                {
                  "Retry-After": String(err.retryAfterSeconds),
                  "X-AsterMux-Pool-Lane": err.lane,
                },
              );
            } else {
              startStream();
              res.write(
                `data: ${JSON.stringify({
                  error: {
                    message:
                      "The Cursor agent stream failed. See server logs for details.",
                    code: "cursor_cli_error",
                  },
                })}\n\n`,
              );
              res.write("data: [DONE]\n\n");
              res.end();
            }
          } else if (!res.writableEnded) {
            res.end();
          }
          console.error(
            `[${new Date().toISOString()}] Agent stream error:`,
            err,
          );
        });
      return;
    }

    let accumulated = "";
    const parseLine = createStreamParser(
      (text) => {
        startStream();
        accumulated += text;
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: displayModel,
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          })}\n\n`,
        );
      },
      () => {
        logTrafficResponse(
          config.verbose,
          model ?? cursorModel,
          accumulated,
          true,
        );
        const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
        const completionTokens = Math.max(
          1,
          Math.round(accumulated.length / 4),
        );
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: displayModel,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
      },
    );

    runAgentStream(
      config,
      workspaceDir,
      effectiveChatOnly,
      cmdArgs,
      parseLine,
      tempDir,
      promptForAgent,
      configDir,
      abortController.signal,
      modelCatalogName,
      poolLane,
      startStream,
    )
      .then(({ code, stderr: stderrOut }) => {
        const latencyMs = Date.now() - streamStart;
        reportRequestEnd(configDir);

        if (stderrOut && isRateLimited(stderrOut)) {
          reportRateLimit(configDir, 60000);
        }

        if (abortController.signal.aborted) {
          /* client disconnected — do not count as success or failure */
        } else if (code !== 0) {
          reportRequestError(configDir, latencyMs);
          logAgentError(
            config.sessionsLogPath,
            method,
            pathname,
            remoteAddress,
            code,
            stderrOut,
          );
        } else {
          reportRequestSuccess(configDir, latencyMs);
        }
        logAccountStats(config.verbose, getAccountStats());
        res.end();
      })
      .catch((err) => {
        reportRequestEnd(configDir);
        if (!abortController.signal.aborted) {
          reportRequestError(configDir, Date.now() - streamStart);
          if (err instanceof AcpPoolQueueError && !res.headersSent) {
            json(
              res,
              err.status,
              {
                error: {
                  message: err.message,
                  code: err.code,
                  type: "rate_limit_error",
                },
              },
              {
                "Retry-After": String(err.retryAfterSeconds),
                "X-AsterMux-Pool-Lane": err.lane,
              },
            );
          } else {
            startStream();
            res.end();
          }
        } else if (!res.writableEnded) {
          res.end();
        }
        console.error(
          `[${new Date().toISOString()}] Agent stream error:`,
          err,
        );
      });
    return;
  }

  const configDir = getNextAccountConfigDir();
  logAccountAssigned(configDir);
  reportRequestStart(configDir);
  const syncStart = Date.now();

  const abortController = new AbortController();
  abortOnClientDisconnect(res, abortController);

  let out;
  try {
    out = await runAgentSync(
      config,
      workspaceDir,
      effectiveChatOnly,
      cmdArgs,
      tempDir,
      promptForAgent,
      configDir,
      abortController.signal,
      modelCatalogName,
      poolLane,
    );
  } catch (error) {
    const syncLatency = Date.now() - syncStart;
    reportRequestEnd(configDir);
    if (error instanceof AcpPoolQueueError) {
      if (!abortController.signal.aborted && !res.headersSent) {
        reportRequestError(configDir, syncLatency);
        json(
          res,
          error.status,
          {
            error: {
              message: error.message,
              code: error.code,
              type: "rate_limit_error",
            },
          },
          {
            "Retry-After": String(error.retryAfterSeconds),
            "X-AsterMux-Pool-Lane": error.lane,
          },
        );
      }
      return;
    }
    throw error;
  }
  const syncLatency = Date.now() - syncStart;
  reportRequestEnd(configDir);
  const poolHeaders = out.pool
    ? {
        "X-AsterMux-Pool-Lane": out.pool.lane,
        ...(out.pool.workerLane
          ? { "X-AsterMux-Worker-Lane": out.pool.workerLane }
          : {}),
        "X-AsterMux-Queue-Wait-Ms": String(out.pool.queueWaitMs),
        "X-AsterMux-Execution-Ms": String(out.pool.executionMs),
      }
    : {};

  if (out.stderr && isRateLimited(out.stderr)) {
    reportRateLimit(configDir, 60000);
  }

  if (out.code !== 0) {
    reportRequestError(configDir, syncLatency);
    logAccountStats(config.verbose, getAccountStats());
    const errMsg = logAgentError(
      config.sessionsLogPath,
      method,
      pathname,
      remoteAddress,
      out.code,
      out.stderr,
    );
    json(res, 500, {
      error: { message: errMsg, code: "cursor_cli_error" },
    });
    return;
  }

  const content = out.stdout.trim();
  if (statelessToolStart && statelessTool) {
    let argumentsJson: string | undefined;
    let validationError: Error | undefined;
    let repaired = false;
    let repairPoolHeaders: Record<string, string> = {};

    try {
      argumentsJson = parseStatelessToolArguments(content, statelessTool);
      recordStatelessFirstPass();
    } catch (error) {
      validationError =
        error instanceof Error ? error : new Error(String(error));
    }

    const maxRepairs = Math.max(0, config.statelessRepairRetries ?? 1);
    for (
      let attempt = 1;
      argumentsJson === undefined && attempt <= maxRepairs;
      attempt += 1
    ) {
      if (abortController.signal.aborted) return;
      recordStatelessRepairAttempt();
      const repairPrompt = statelessToolRepairPrompt(
        agentPrompt,
        statelessTool,
        validationError?.message ?? "invalid structured output",
      );

      let repairWorkspaceDir: string;
      let repairTempDir: string | undefined;
      try {
        const repairWs = resolveWorkspace(config, headerWs, effectiveChatOnly);
        repairWorkspaceDir = repairWs.workspaceDir;
        repairTempDir = repairWs.tempDir;
      } catch (error) {
        validationError =
          error instanceof Error ? error : new Error(String(error));
        break;
      }

      const repairCmdArgs = buildAgentFixedArgs(
        config,
        repairWorkspaceDir,
        cursorModel,
        false,
        mode,
        effectiveChatOnly,
      );
      reportRequestStart(configDir);
      let repairOut;
      try {
        repairOut = await runAgentSync(
          config,
          repairWorkspaceDir,
          effectiveChatOnly,
          repairCmdArgs,
          repairTempDir,
          repairPrompt,
          configDir,
          abortController.signal,
          modelCatalogName,
          "batch",
        );
      } catch (error) {
        reportRequestEnd(configDir);
        if (abortController.signal.aborted) return;
        if (error instanceof AcpPoolQueueError) {
          json(
            res,
            error.status,
            {
              error: {
                message: error.message,
                code: error.code,
                type: "rate_limit_error",
              },
            },
            {
              "Retry-After": String(error.retryAfterSeconds),
              "X-AsterMux-Pool-Lane": error.lane,
              "X-AsterMux-Stateless-Repair": String(attempt),
            },
          );
          return;
        }
        validationError =
          error instanceof Error ? error : new Error(String(error));
        continue;
      }
      reportRequestEnd(configDir);

      if (repairOut.stderr && isRateLimited(repairOut.stderr)) {
        reportRateLimit(configDir, 60_000);
      }
      if (repairOut.code !== 0) {
        validationError = new Error(
          logAgentError(
            config.sessionsLogPath,
            method,
            pathname,
            remoteAddress,
            repairOut.code,
            repairOut.stderr,
          ),
        );
        continue;
      }

      try {
        argumentsJson = parseStatelessToolArguments(
          repairOut.stdout.trim(),
          statelessTool,
        );
        repaired = true;
        recordStatelessRepairCompleted();
        repairPoolHeaders = repairOut.pool
          ? {
              "X-AsterMux-Repair-Pool-Lane": repairOut.pool.lane,
              ...(repairOut.pool.workerLane
                ? { "X-AsterMux-Repair-Worker-Lane": repairOut.pool.workerLane }
                : {}),
              "X-AsterMux-Repair-Queue-Wait-Ms": String(
                repairOut.pool.queueWaitMs,
              ),
              "X-AsterMux-Repair-Execution-Ms": String(
                repairOut.pool.executionMs,
              ),
            }
          : {};
      } catch (error) {
        validationError =
          error instanceof Error ? error : new Error(String(error));
      }

    }

    if (argumentsJson === undefined) {
      recordStatelessFailure();
      reportRequestError(configDir, Date.now() - syncStart);
      logAccountStats(config.verbose, getAccountStats());
      json(res, 502, {
        error: {
          message: validationError?.message ?? "Invalid stateless tool output",
          code: "stateless_tool_output_invalid",
          type: "api_error",
        },
      });
      return;
    }

    const callId = `call_${randomUUID().replace(/-/g, "")}`;
    const result: ToolTurnResult = {
      status: "tool_calls",
      text: "",
      reasoning: "",
      toolCalls: [
        {
          callId,
          itemId: `item_${randomUUID().replace(/-/g, "")}`,
          name: statelessTool.name,
          arguments: argumentsJson,
        },
      ],
    };
    reportRequestSuccess(configDir, Date.now() - syncStart);
    logTrafficResponse(config.verbose, model ?? cursorModel, argumentsJson, false);
    logAccountStats(config.verbose, getAccountStats());
    json(
      res,
      200,
      chatToolResponse({
        id,
        created,
        model: displayModel,
        result,
        promptLength: agentPrompt.length,
      }),
      {
        ...truncatedHeaders,
        ...poolHeaders,
        ...repairPoolHeaders,
        "X-AsterMux-Tool-Mode": "stateless",
        ...(repaired ? { "X-AsterMux-Stateless-Repair": "1" } : {}),
        ...(promptCompacted ? { "X-AsterMux-Prompt-Compacted": "json" } : {}),
      },
    );
    return;
  }

  reportRequestSuccess(configDir, syncLatency);
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);

  const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
  const completionTokens = Math.max(1, Math.round(content.length / 4));
  const totalTokens = promptTokens + completionTokens;

  logAccountStats(config.verbose, getAccountStats());
  json(
    res,
    200,
    {
      id,
      object: "chat.completion",
      created,
      model: displayModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    },
    { ...truncatedHeaders, ...poolHeaders },
  );
}
