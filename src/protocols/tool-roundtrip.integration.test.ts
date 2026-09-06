import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayConfig } from "../gateway/config.js";
import { startGatewayServer } from "../gateway/server.js";

vi.mock("../provider/cursor-agent.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([
    { id: "gpt-4", name: "gpt-4" },
  ]),
}));

const fakeServerPath = join(
  process.cwd(),
  "src",
  "acp",
  "__tests__",
  "fake-agent.mjs",
);
const servers: http.Server[] = [];
const batchDirs: string[] = [];

function config(scenario = "tool_call"): GatewayConfig {
  return {
    agentBin: "agent",
    acpCommand: process.execPath,
    acpArgs: [fakeServerPath],
    acpEnv: { FAKE_ACP_SCENARIO: scenario },
    host: "127.0.0.1",
    port: 0,
    defaultModel: "gpt-4",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 10_000,
    toolSessionMode: "stateful",
    sessionsLogPath: "/tmp/astermux-tool-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    gatewayPackageVersion: "0.0.0-test",
  };
}

async function start(
  scenario = "tool_call",
  overrides: Partial<GatewayConfig> = {},
) {
  const [server] = startGatewayServer({
    version: "test",
    config: { ...config(scenario), ...overrides },
  });
  servers.push(server as http.Server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    text: await response.text(),
    headers: response.headers,
  };
}

async function get(base: string, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, text: await response.text() };
}

function sseData(text: string): any[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  for (const dir of batchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.each([false, true])("ACP tool APIs stream=%s", (stream) => {
  it("round-trips Chat Completions tool calls", async () => {
    const base = await start();
    const initial = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      stream,
      messages: [{ role: "user", content: "Weather?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
      ],
    });
    expect(initial.status).toBe(200);
    const chunks = stream ? sseData(initial.text) : [];
    const payload = stream ? undefined : JSON.parse(initial.text);
    const call = stream
      ? chunks
          .flatMap((chunk) => chunk.choices ?? [])
          .flatMap((choice: any) => choice.delta?.tool_calls ?? [])[0]
      : payload.choices[0].message.tool_calls[0];
    expect(call.function.name).toBe("weather");
    expect(
      stream
        ? chunks.some(
            (chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls",
          )
        : payload.choices[0].finish_reason === "tool_calls",
    ).toBe(true);

    const follow = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      stream: false,
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [call],
        },
        {
          role: "tool",
          tool_call_id: call.id,
          content: "sunny",
        },
      ],
    });
    expect(follow.status).toBe(200);
    expect(JSON.parse(follow.text).choices[0].message.content).toContain(
      "Tool result: sunny",
    );
  });

  it("round-trips Responses function calls", async () => {
    const base = await start();
    const initial = await post(base, "/v1/responses", {
      model: "gpt-4",
      stream,
      input: "Weather?",
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    });
    expect(initial.status).toBe(200);
    const events = stream ? sseData(initial.text) : [];
    const payload = stream
      ? events.find((event) => event.type === "response.completed").response
      : JSON.parse(initial.text);
    const call = payload.output.find(
      (item: any) => item.type === "function_call",
    );
    expect(call.name).toBe("weather");

    const follow = await post(base, "/v1/responses", {
      model: "gpt-4",
      stream: false,
      previous_response_id: payload.id,
      input: [
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "sunny",
        },
      ],
    });
    expect(follow.status).toBe(200);
    expect(JSON.parse(follow.text).output_text).toContain("Tool result: sunny");
  });

  it("round-trips Anthropic tool_use blocks", async () => {
    const base = await start();
    const initial = await post(base, "/v1/messages", {
      model: "gpt-4",
      max_tokens: 256,
      stream,
      messages: [{ role: "user", content: "Weather?" }],
      tools: [
        {
          name: "weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    });
    expect(initial.status).toBe(200);
    const events = stream ? sseData(initial.text) : [];
    const payload = stream ? undefined : JSON.parse(initial.text);
    const call = stream
      ? events.find(
          (event) =>
            event.type === "content_block_start" &&
            event.content_block?.type === "tool_use",
        ).content_block
      : payload.content.find((block: any) => block.type === "tool_use");
    expect(call.name).toBe("weather");
    if (stream) {
      expect(
        events.some(
          (event) =>
            event.type === "content_block_delta" &&
            event.delta?.type === "input_json_delta",
        ),
      ).toBe(true);
    } else {
      expect(payload.stop_reason).toBe("tool_use");
    }

    const follow = await post(base, "/v1/messages", {
      model: "gpt-4",
      max_tokens: 256,
      stream: false,
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.input,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: call.id,
              content: "sunny",
            },
          ],
        },
      ],
    });
    expect(follow.status).toBe(200);
    expect(JSON.parse(follow.text).content[0].text).toContain(
      "Tool result: sunny",
    );
  });
});

describe("stateless external Tool v2", () => {
  const weatherTool = {
    type: "function",
    function: {
      name: "weather",
      description: "Get weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    },
  };

  it("reconstructs Chat tool history when a later user reminder follows the tool result", async () => {
    const base = await start("tool_stateless_history", {
      toolSessionMode: "stateless",
      toolSessionMaxPerOwner: 1,
      toolSessionMaxGlobal: 1,
    });
    const headers = { authorization: "Bearer shared-newapi-owner" };
    const initial = await post(
      base,
      "/v1/chat/completions",
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "Weather?" }],
        tools: [weatherTool],
      },
      headers,
    );
    expect(initial.status).toBe(200);
    const call = JSON.parse(initial.text).choices[0].message.tool_calls[0];

    const afterInitial = await get(base, "/v1/runtime/status", headers);
    expect(JSON.parse(afterInitial.text).tool_sessions.parked).toBe(0);

    const follow = await post(
      base,
      "/v1/chat/completions",
      {
        model: "gpt-4",
        messages: [
          { role: "user", content: "Weather?" },
          { role: "assistant", content: null, tool_calls: [call] },
          {
            role: "tool",
            tool_call_id: call.id,
            content: "sunny",
          },
          {
            role: "user",
            content: "<system-reminder>continue from the tool result</system-reminder>",
          },
        ],
        tools: [weatherTool],
      },
      headers,
    );
    expect(follow.status).toBe(200);
    const payload = JSON.parse(follow.text);
    expect(payload.choices[0].finish_reason).toBe("stop");
    expect(payload.choices[0].message.content).toContain("Recovered from full history");
    const status = await get(base, "/v1/runtime/status", headers);
    expect(JSON.parse(status.text).tool_sessions.parked).toBe(0);
  });

  it("does not consume parked-session capacity for repeated requests sharing one NewAPI bearer", async () => {
    const base = await start("tool_call", {
      toolSessionMode: "stateless",
      toolSessionMaxPerOwner: 1,
      toolSessionMaxGlobal: 1,
    });
    const headers = { authorization: "Bearer one-shared-newapi-key" };
    for (let i = 0; i < 4; i += 1) {
      const response = await post(
        base,
        "/v1/chat/completions",
        {
          model: "gpt-4",
          messages: [{ role: "user", content: `Weather ${i}?` }],
          tools: [weatherTool],
        },
        headers,
      );
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text).choices[0].finish_reason).toBe("tool_calls");
      const status = await get(base, "/v1/runtime/status", headers);
      expect(JSON.parse(status.text).tool_sessions.parked).toBe(0);
    }
  });

  it("handles a Claude-Code-like 65-tool streaming request without parking", async () => {
    const base = await start("tool_call", {
      toolSessionMode: "stateless",
      toolSessionMaxPerOwner: 1,
      toolSessionMaxGlobal: 1,
    });
    const tools = Array.from({ length: 65 }, (_, index) => ({
      type: "function",
      function: {
        name: index === 0 ? "weather" : `tool_${index}`,
        description: `Tool ${index}`,
        parameters: {
          type: "object",
          properties: { city: { type: "string" }, index: { type: "number" } },
        },
      },
    }));
    const response = await post(
      base,
      "/v1/chat/completions",
      {
        model: "gpt-4",
        stream: true,
        max_tokens: 64_000,
        messages: [
          { role: "system", content: "X".repeat(120_000) },
          { role: "user", content: "Use the appropriate tool." },
        ],
        tools,
      },
      { authorization: "Bearer shared-newapi-owner" },
    );
    expect(response.status).toBe(200);
    const chunks = sseData(response.text);
    expect(
      chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls"),
    ).toBe(true);
    const status = await get(base, "/v1/runtime/status");
    expect(JSON.parse(status.text).tool_sessions.parked).toBe(0);
  });

  it("reconstructs multiple parallel tool results from a fresh session", async () => {
    const base = await start("tool_stateless_parallel_history", {
      toolSessionMode: "stateless",
    });
    const tools = [
      weatherTool,
      {
        type: "function",
        function: {
          name: "time",
          description: "Get local time",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const initial = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Use both tools." }],
      tools,
      parallel_tool_calls: true,
    });
    expect(initial.status).toBe(200);
    const calls = JSON.parse(initial.text).choices[0].message.tool_calls;
    expect(calls).toHaveLength(2);

    const follow = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [
        { role: "user", content: "Use both tools." },
        { role: "assistant", content: null, tool_calls: calls },
        { role: "tool", tool_call_id: calls[0].id, content: "sunny" },
        { role: "tool", tool_call_id: calls[1].id, content: "10:30" },
        { role: "user", content: "<system-reminder>continue</system-reminder>" },
      ],
      tools,
    });
    expect(follow.status).toBe(200);
    expect(JSON.parse(follow.text).choices[0].message.content).toContain(
      "Recovered both parallel tool results",
    );
    expect(JSON.parse((await get(base, "/v1/runtime/status")).text).tool_sessions.parked).toBe(0);
  });

  it("bounds concurrent stateless Tool turns with the warm Tool queue", async () => {
    const base = await start("tool_delay", {
      toolSessionMode: "stateless",
      acpToolPoolSize: 1,
      acpToolQueueMax: 1,
      acpToolQueueTimeoutMs: 2_000,
    });
    const body = {
      model: "gpt-4",
      messages: [{ role: "user", content: "Weather?" }],
      tools: [weatherTool],
    };
    const headers = { authorization: "Bearer shared-newapi-owner" };

    const first = post(base, "/v1/chat/completions", body, headers);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = post(base, "/v1/chat/completions", body, headers);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const overloaded = await post(base, "/v1/chat/completions", body, headers);

    expect(overloaded.status).toBe(429);
    expect(JSON.parse(overloaded.text).error.code).toBe("tool_queue_overloaded");
    expect(overloaded.headers.get("retry-after")).toBe("2");

    const [one, two] = await Promise.all([first, second]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    const status = JSON.parse((await get(base, "/v1/runtime/status")).text);
    expect(status.tool_sessions.parked).toBe(0);
    expect(status.tool_pool.queued).toBe(0);
    expect(status.tool_pool.workers).toBe(1);
  });

  it("reconstructs Anthropic tool_use/tool_result history with extra content", async () => {
    const base = await start("tool_stateless_history", {
      toolSessionMode: "stateless",
      toolSessionMaxPerOwner: 1,
      toolSessionMaxGlobal: 1,
    });
    const tool = {
      name: "weather",
      description: "Get weather",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    };
    const initial = await post(base, "/v1/messages", {
      model: "gpt-4",
      max_tokens: 256,
      messages: [{ role: "user", content: "Weather?" }],
      tools: [tool],
    });
    expect(initial.status).toBe(200);
    const first = JSON.parse(initial.text);
    const call = first.content.find((block: any) => block.type === "tool_use");

    const follow = await post(base, "/v1/messages", {
      model: "gpt-4",
      max_tokens: 256,
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: call.id, name: call.name, input: call.input },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call.id, content: "sunny" },
            { type: "text", text: "<system-reminder>continue</system-reminder>" },
          ],
        },
      ],
      tools: [tool],
    });
    expect(follow.status).toBe(200);
    expect(JSON.parse(follow.text).content[0].text).toContain(
      "Recovered from full history",
    );
    const status = await get(base, "/v1/runtime/status");
    expect(JSON.parse(status.text).tool_sessions.parked).toBe(0);
  });
});

describe("ACP tool session errors", () => {
  it("returns conflict for unknown tool call ids", async () => {
    const base = await start();
    const response = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [
        { role: "tool", tool_call_id: "call_missing", content: "result" },
      ],
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.text).error.code).toBe("tool_session_expired");
  });

  it("supports partial parallel results", async () => {
    const base = await start("tool_parallel");
    const initial = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Both?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            parameters: { type: "object", properties: {} },
          },
        },
        {
          type: "function",
          function: {
            name: "time",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    const calls = JSON.parse(initial.text).choices[0].message.tool_calls;
    expect(calls).toHaveLength(2);

    const partial = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [
        {
          role: "tool",
          tool_call_id: calls[0].id,
          content: "weather-result",
        },
      ],
    });
    const remaining = JSON.parse(partial.text).choices[0].message.tool_calls;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(calls[1].id);

    const final = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [
        {
          role: "tool",
          tool_call_id: calls[1].id,
          content: "time-result",
        },
      ],
    });
    expect(JSON.parse(final.text).choices[0].message.content).toContain(
      "weather-result, time-result",
    );
  });

  it("binds pending calls to the initiating API owner", async () => {
    const base = await start();
    const initial = await post(
      base,
      "/v1/chat/completions",
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "Weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "weather",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      { authorization: "Bearer owner-a" },
    );
    const call = JSON.parse(initial.text).choices[0].message.tool_calls[0];
    const wrongOwner = await post(
      base,
      "/v1/chat/completions",
      {
        model: "gpt-4",
        messages: [
          {
            role: "tool",
            tool_call_id: call.id,
            content: "stolen",
          },
        ],
      },
      { authorization: "Bearer owner-b" },
    );
    expect(wrongOwner.status).toBe(409);
  });

  it("serializes concurrent results for one parallel turn", async () => {
    const base = await start("tool_parallel");
    const initial = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Both?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            parameters: { type: "object", properties: {} },
          },
        },
        {
          type: "function",
          function: {
            name: "time",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    const calls = JSON.parse(initial.text).choices[0].message.tool_calls;
    const replies = await Promise.all(
      calls.map((call: any) =>
        post(base, "/v1/chat/completions", {
          model: "gpt-4",
          messages: [
            {
              role: "tool",
              tool_call_id: call.id,
              content: `${call.function.name}-result`,
            },
          ],
        }),
      ),
    );
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    const payloads = replies.map((reply) => JSON.parse(reply.text));
    expect(
      payloads.some((payload) =>
        payload.choices[0].message.content?.includes(
          "weather-result, time-result",
        ),
      ),
    ).toBe(true);
  });

  it("supports allowlisted stateless output functions without parking a Tool session", async () => {
    const base = await start("stateless_output", {
      statelessToolNames: ["weather"],
      toolSessionMaxPerOwner: 1,
      toolSessionMaxGlobal: 1,
    });
    const body = {
      model: "gpt-4",
      messages: [{ role: "user", content: "Return the city." }],
      parallel_tool_calls: false,
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
    };
    const headers = { authorization: "Bearer stateless-owner" };

    for (let i = 0; i < 2; i += 1) {
      const response = await post(base, "/v1/chat/completions", body, headers);
      expect(response.status).toBe(200);
      const payload = JSON.parse(response.text);
      expect(payload.choices[0].finish_reason).toBe("tool_calls");
      const call = payload.choices[0].message.tool_calls[0];
      expect(call.function.name).toBe("weather");
      expect(JSON.parse(call.function.arguments)).toEqual({ city: "Paris" });
    }
  });

  it("repairs one invalid stateless output without changing the tool response shape", async () => {
    const base = await start("stateless_output_repair", {
      statelessToolNames: ["weather"],
      statelessRepairRetries: 1,
    });
    const response = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Return the city." }],
      parallel_tool_calls: false,
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-astermux-stateless-repair")).toBe("1");
    const payload = JSON.parse(response.text);
    expect(payload.choices[0].finish_reason).toBe("tool_calls");
    const call = payload.choices[0].message.tool_calls[0];
    expect(call.function.name).toBe("weather");
    expect(JSON.parse(call.function.arguments)).toEqual({ city: "Paris" });
  });

  it("can disable stateless repair and preserve a final validation error", async () => {
    const base = await start("stateless_output_repair", {
      statelessToolNames: ["weather"],
      statelessRepairRetries: 0,
    });
    const response = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Return the city." }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
    });
    expect(response.status).toBe(502);
    expect(JSON.parse(response.text).error.code).toBe(
      "stateless_tool_output_invalid",
    );
  });

  it("rejects over-capacity Tool starts before expensive ACP setup", async () => {
    const base = await start("tool_capacity_slow_new", {
      toolSessionMaxPerOwner: 1,
      toolSessionMaxGlobal: 1,
    });
    const body = {
      model: "gpt-4",
      messages: [{ role: "user", content: "Weather?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    };
    const headers = { authorization: "Bearer one-owner" };

    const first = await post(base, "/v1/chat/completions", body, headers);
    expect(first.status).toBe(200);

    const started = Date.now();
    const limited = await post(base, "/v1/chat/completions", body, headers);
    const elapsed = Date.now() - started;
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.text).error.code).toBe("tool_session_limit");
    // A cold fake ACP session/new deliberately costs 800ms in this scenario.
    // Capacity rejection must happen before any of that work starts.
    expect(elapsed).toBeLessThan(300);
  });

  it("runs persistent async batches through the batch API", async () => {
    const batchDir = fs.mkdtempSync(join(os.tmpdir(), "cursor-batch-integration-"));
    batchDirs.push(batchDir);
    const base = await start("stateless_output", {
      batchEnabled: true,
      batchDir,
      batchConcurrency: 2,
      batchMaxRequests: 10,
      statelessToolNames: ["weather"],
      // This integration test isolates HTTP routing + persistence. Dedicated
      // batch hot-pool scheduling is covered by execution-pool.test.ts.
      acpBatchPoolSize: 0,
    });
    const body = {
      model: "gpt-4",
      messages: [{ role: "user", content: "Return the city." }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
    };
    const created = await post(base, "/v1/batches", {
      requests: [
        { custom_id: "one", body },
        { custom_id: "two", body },
      ],
    });
    expect(created.status).toBe(202);
    const batchId = JSON.parse(created.text).id as string;

    let status = "queued";
    for (let i = 0; i < 100 && status !== "completed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const current = await get(base, `/v1/batches/${batchId}`);
      expect(current.status).toBe(200);
      status = JSON.parse(current.text).status;
    }
    expect(status).toBe("completed");
    const results = await get(base, `/v1/batches/${batchId}/results`);
    expect(results.status).toBe(200);
    const payload = JSON.parse(results.text);
    expect(payload.request_counts.completed).toBe(2);
    expect(payload.data.every((item: any) => item.response.status_code === 200)).toBe(true);
    expect(fs.existsSync(join(batchDir, `${batchId}.json`))).toBe(true);
  });

  it("rejects unsupported tool types and store=false tool loops", async () => {
    const base = await start();
    const unsupported = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Search" }],
      tools: [{ type: "web_search" }],
    });
    expect(unsupported.status).toBe(400);
    expect(JSON.parse(unsupported.text).error.code).toBe("invalid_tools");

    const noStore = await post(base, "/v1/responses", {
      model: "gpt-4",
      input: "Weather?",
      store: false,
      tools: [
        {
          type: "function",
          name: "weather",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    expect(noStore.status).toBe(400);
    expect(JSON.parse(noStore.text).error.code).toBe("invalid_store");
  });
});
