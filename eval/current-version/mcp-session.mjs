import readline from "node:readline";

import { createAuditClient } from "./audit-lib.mjs";

const url =
  process.env.CONNECTA_EVAL_URL ?? "http://127.0.0.1:8797/mcp";
const token = process.env.CONNECTA_EVAL_TOKEN ?? "connecta-eval-token";
const tokenizerName =
  process.env.CONNECTA_EVAL_TOKENIZER ?? "o200k_base";
const context = await createAuditClient({ url, token, tokenizerName });

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

emit({
  event: "connected",
  tokenizer: tokenizerName,
  connection: context.connection,
});

const input = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

for await (const line of input) {
  if (!line.trim()) continue;
  let command;
  try {
    command = JSON.parse(line);
  } catch (error) {
    emit({ event: "client_error", message: String(error) });
    continue;
  }
  if (command.action === "close") break;
  if (command.action === "summary") {
    emit({ event: "summary", observations: context.observations });
    continue;
  }
  if (command.action !== "call" || typeof command.tool !== "string") {
    emit({ event: "client_error", message: "Expected action=call and tool." });
    continue;
  }
  try {
    const observed = await context.call(
      command.name ?? command.tool,
      command.tool,
      command.args ?? {},
    );
    emit({
      event: "tool_result",
      observation: observed.observation,
      result: observed.result,
    });
  } catch (error) {
    emit({
      event: "transport_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

input.close();
await context.close();
