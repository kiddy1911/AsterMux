#!/usr/bin/env node
/**
 * Example: use the SDK with the OpenAI client (getOpenAIOptionsAsync).
 * The gateway starts in the background automatically if not already running,
 * and the SDK stops it when this script exits.
 *
 * Prereqs: Cursor CLI installed and logged in (agent login). Install OpenAI SDK: npm install openai
 *
 * Run: node examples/sdk/openai-sdk.mjs
 */

import OpenAI from "openai";
import { getOpenAIOptionsAsync } from "astermux";

async function main() {
  const opts = await getOpenAIOptionsAsync();
  const client = new OpenAI(opts);

  console.log("Chat completion via OpenAI SDK + astermux (gateway starts automatically if needed)");
  console.log("---");

  const completion = await client.chat.completions.create({
    model: "auto",
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
  });

  const content = completion.choices[0]?.message?.content ?? "(no content)";
  console.log("Response:", content);
  console.log("---");
  console.log("Usage:", completion.usage ?? "N/A");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
