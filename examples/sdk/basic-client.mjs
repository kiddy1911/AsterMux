#!/usr/bin/env node
/**
 * Example: use the SDK minimal client (createAsterMuxClient).
 * The gateway starts in the background automatically if not already running,
 * and the SDK stops it when this script exits.
 *
 * Prereq: Cursor CLI installed and logged in (agent login)
 *
 * Run: node examples/sdk/basic-client.mjs
 */

import { createAsterMuxClient } from "astermux";

async function main() {
  const gateway = createAsterMuxClient();

  console.log("Gateway will start automatically if needed. Base URL:", gateway.baseUrl);
  console.log("---");

  const data = await gateway.chatCompletionsCreate({
    model: "auto",
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
  });

  const content = data.choices?.[0]?.message?.content ?? "(no content)";
  console.log("Response:", content);
  console.log("---");
  console.log("Full response (choices):", JSON.stringify(data.choices, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
