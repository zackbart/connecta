/**
 * Local model endpoints for host-fidelity probes: a real CLI talks to them with
 * a fake key, so a probe costs no model allowance. Each script says which calls
 * the "model" makes, in order; after the last it finishes with plain text.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serveFetch, type Served } from "./serve.js";

export interface ScriptedCall {
  tool: string;
  input: unknown;
}

export interface ScriptedModel extends Served {
  /** Names the host offered in each model request. */
  offered: string[][];
  /** The results the host returned to the model. */
  toolResults: unknown[];
}

/** Anthropic Messages streaming. A batch of several calls is one parallel assistant turn. */
export async function scriptedClaudeModel(
  batches: ScriptedCall[][],
  beforeBatch?: (index: number) => Promise<void>,
): Promise<ScriptedModel> {
  const offered: string[][] = [];
  const toolResults: unknown[] = [];
  let next = 0;
  const served = await serveFetch(async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/messages"))
      return Response.json({ input_tokens: 10 }, { status: url.pathname.includes("count_tokens") ? 200 : 404 });
    const body = (await request.json()) as {
      tools?: { name: string }[];
      messages: { content: unknown }[];
      model: string;
    };
    offered.push((body.tools ?? []).map((tool) => tool.name));
    const last = body.messages.at(-1)?.content;
    if (Array.isArray(last))
      for (const block of last as { type?: string; content?: unknown; is_error?: boolean }[])
        if (block.type === "tool_result")
          toolResults.push({ isError: block.is_error === true, content: block.content });
    const names = new Set(body.tools?.map((tool) => tool.name));
    const batch = batches[next];
    const use = batch && batch.every((call) => names.has(call.tool));
    if (use) {
      await beforeBatch?.(next);
      next += 1;
    }
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const blocks: Record<string, unknown>[] = use
      ? batch.flatMap((call, index) => [
          {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: `toolu_${next}_${index}`, name: call.tool, input: {} },
          },
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
          },
          { type: "content_block_stop", index },
        ])
      : [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Scripted run finished." } },
          { type: "content_block_stop", index: 0 },
        ];
    const events: Record<string, unknown>[] = [
      {
        type: "message_start",
        message: {
          id: `msg_${offered.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      },
      ...blocks,
      {
        type: "message_delta",
        delta: { stop_reason: use ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  return Object.assign(served, { offered, toolResults });
}

/** Responses streaming with host `exec`: each program calls tools from Codex code mode. */
export async function scriptedCodexModel(
  programs: string[],
  beforeProgram?: (index: number) => Promise<void>,
): Promise<ScriptedModel> {
  const offered: string[][] = [];
  const toolResults: unknown[] = [];
  let next = 0;
  const served = await serveFetch(async (request) => {
    const body = (await request.json()) as { input?: { type?: string; output?: unknown }[] };
    for (const item of body.input ?? []) if (item.type === "custom_tool_call_output") toolResults.push(item.output);
    const program = programs[next];
    if (program !== undefined) await beforeProgram?.(next);
    const item =
      program !== undefined
        ? {
            type: "custom_tool_call",
            id: `ctc_${next}`,
            call_id: `call_${next}`,
            name: "exec",
            namespace: "functions",
            input: program,
          }
        : {
            type: "message",
            id: "msg_done",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Scripted run finished.", annotations: [] }],
          };
    next += 1;
    const response = {
      id: `resp_${next}`,
      object: "response",
      status: "completed",
      model: "gpt-6.1-sol",
      output: [item],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 } },
    };
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    return new Response(
      events
        .map(
          (event, sequence) =>
            `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  return Object.assign(served, { offered, toolResults });
}

/** A launcher that runs the real Claude Code against a scripted model, with an empty home and a fake key. */
export async function claudeWrapper(root: string, modelUrl: string, toolSearch = false): Promise<string> {
  const path = join(root, "claude-wrapper.cjs");
  await writeFile(
    path,
    `#!/usr/bin/env node
const child = require("node:child_process").spawn("claude", process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, HOME: ${JSON.stringify(root)}, ANTHROPIC_API_KEY: "sk-fake-local-only", ANTHROPIC_BASE_URL: ${JSON.stringify(modelUrl)}, ENABLE_TOOL_SEARCH: ${JSON.stringify(String(toolSearch))} },
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 1));
`,
    { mode: 0o700 },
  );
  return path;
}

/** A launcher that points the real Codex app-server at a scripted model. */
export async function codexWrapper(root: string, modelUrl: string): Promise<{ executable: string; authFile: string }> {
  const authFile = join(root, "auth.json");
  await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: "sk-fake-local-only" }));
  const executable = join(root, "codex-wrapper.cjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path").join(process.env.CODEX_HOME, "config.toml");
fs.writeFileSync(path, 'model_provider = "scripted"\\n' + fs.readFileSync(path, "utf8") + '\\n[model_providers.scripted]\\nname = "scripted"\\nbase_url = "${modelUrl}/v1"\\nwire_api = "responses"\\nrequires_openai_auth = false\\n');
const child = require("node:child_process").spawn("codex", ["app-server", "--stdio"], { stdio: "inherit" });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 1));
`,
    { mode: 0o700 },
  );
  return { executable, authFile };
}
