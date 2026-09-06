#!/usr/bin/env node
/**
 * Example: stream chat completion using the SDK minimal client.
 * The gateway starts in the background automatically if not already running,
 * and the SDK stops it when this script exits.
 *
 * Prereq: Cursor CLI installed and logged in (agent login)
 *
 * Run: node examples/sdk/streaming.mjs
 */

import { createAsterMuxClient } from "astermux";

async function main() {
  const gateway = createAsterMuxClient();

  console.log("Streaming (gateway will start automatically if needed)");
  console.log("---");

  const res = await gateway.fetch("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "Count from 1 to 5, one number per line." }],
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gateway error ${res.status}: ${err}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") {
          console.log("\n--- [DONE]");
          continue;
        }
        try {
          const obj = JSON.parse(data);
          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) {
            process.stdout.write(delta);
            fullContent += delta;
          }
        } catch (_) {}
      }
    }
  }

  if (buffer.startsWith("data: ") && buffer.slice(6) !== "[DONE]") {
    try {
      const obj = JSON.parse(buffer.slice(6));
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) {
        process.stdout.write(delta);
        fullContent += delta;
      }
    } catch (_) {}
  }

  console.log("\n---\nStreamed", fullContent.length, "chars total.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
