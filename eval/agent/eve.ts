/** Real Eve host, subscription model, and operator-authored helper definitions per trial. */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CodexOptions, CodexRun } from "./codex.js";
import { toolId, type StreamEvent } from "./trace.js";
import { ROOT } from "../support/meta.js";
import { serveFetch } from "../support/serve.js";
import { startProcess, stopProcess } from "../support/workerd.js";

const helper = join(ROOT, "packages/connecta-eve");
const requireEve = createRequire(join(helper, "package.json"));

/** Which helper configuration a batch tests; the defaults keep earlier batches comparable. */
export interface EveConnection {
  /** Eve names a connection after its file; tools become `<connection>__<tool>`. */
  connection?: string;
  /** Connection description; `null` omits it, so the helper's own default applies. */
  description?: string | null;
}

/** Why the helper this runner imports cannot load, in terms an operator can act on. */
export function eveHelperProblem(dir = helper): string | undefined {
  if (!existsSync(join(dir, "node_modules/eve/package.json")))
    return `Eve runner needs the helper's dependencies: ${join(dir, "node_modules/eve")} is missing. Run pnpm install.`;
  if (!existsSync(join(dir, "dist/index.js")))
    return `Eve runner needs the built helper: ${join(dir, "dist/index.js")} is missing. Run pnpm --filter @zackbart/connecta-eve run build, or drop --no-build.`;
  return undefined;
}

export function eveVersion(): string {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Eve runner requires Node 24+");
  const problem = eveHelperProblem();
  if (problem) throw new Error(problem);
  const version = JSON.parse(readFileSync(join(helper, "node_modules/eve/package.json"), "utf8")).version;
  if (version !== "1.0.0-rc.4") throw new Error(`Eve runner requires eve@1.0.0-rc.4; got ${version}`);
  return version;
}

export async function runEve(options: CodexOptions & EveConnection & { testModelSource?: string }): Promise<CodexRun> {
  eveVersion();
  const connectionName = options.connection ?? "connecta";
  if (!/^[A-Za-z0-9._-]+$/.test(connectionName))
    throw new Error(`Eve connection "${connectionName}" must be usable as a file name under agent/connections`);
  const prefix = `${connectionName}__`;
  const description = options.description === undefined ? "Connecta task tools" : options.description;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Eve timeout must be positive");
  const root = await mkdtemp(join(tmpdir(), "connecta-eval-eve-"));
  const events: StreamEvent[] = [];
  const turnStarts: number[] = [];
  const started = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const signal = controller.signal;
  let server: ReturnType<typeof startProcess> | undefined;
  let stderrTail = "";
  let model: string | undefined;
  const loadedTools = [...new Set([...options.allowedTools, ...options.deniedTools])].map(toolId);
  const push = (event: StreamEvent) => {
    events.push(event);
    options.onEvent?.(event);
  };
  let exitCode = 0;
  try {
    await Promise.all([
      mkdir(join(root, "agent/connections"), { recursive: true }),
      mkdir(join(root, "agent/instructions"), { recursive: true }),
      mkdir(join(root, "node_modules/@zackbart"), { recursive: true }),
    ]);
    // Resolve the installed RC once; no install, registry request, or shared build.
    await symlink(join(helper, "node_modules/eve"), join(root, "node_modules/eve"));
    await symlink(helper, join(root, "node_modules/@zackbart/connecta-eve"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "connecta-eval-eve",
        type: "module",
        dependencies: { eve: "1.0.0-rc.4", "@zackbart/connecta-eve": `file:${helper}` },
      }),
    );
    const endpoint = new URL(options.mcpUrl);
    const pool = endpoint.pathname.match(/^\/agent\/([a-z0-9_-]+)$/)?.[1];
    const connection = { url: pool ? endpoint.origin : options.mcpUrl, ...(pool ? { pool } : {}) };
    const common = `${JSON.stringify(connection).slice(0, -1)}, getToken: () => process.env.CONNECTA_ACCESS_TOKEN }`;
    await writeFile(
      join(root, `agent/connections/${connectionName}.ts`),
      `
import { connectaConnection } from "@zackbart/connecta-eve";
const allow = ${JSON.stringify(options.allowedTools.map((t) => `${prefix}${t}`))};
const deny = ${JSON.stringify(options.deniedTools.map((t) => `${prefix}${t}`))};
export default connectaConnection({ ...${common},${description === null ? "" : ` description: ${JSON.stringify(description)},`} approval: ({ toolName }) => deny.includes(toolName) || !allow.includes(toolName) ? "denied" : "approved" });
`,
    );
    await writeFile(
      join(root, "agent/instructions/connecta.ts"),
      `import { connectaInstructions } from "@zackbart/connecta-eve"; export default connectaInstructions({ ...${common}${options.connection === undefined ? "" : `, connection: ${JSON.stringify(connectionName)}`} });`,
    );
    await writeFile(
      join(root, "agent/instructions/task.md"),
      `Complete the user's task using only the ${connectionName} MCP tools. Do not use shell, files, web, or other services.`,
    );
    const observed = join(root, "model.jsonl");
    if (options.testModelSource) await writeFile(join(root, "fixture.mjs"), options.testModelSource);
    // Observe the actual provider request inventory and response metadata, rather
    // than trusting /info's configured model. No prompts or credentials are logged.
    await writeFile(
      join(root, "model.mjs"),
      `
${options.testModelSource ? `import base from "./fixture.mjs";` : `import { chatgpt } from "eve/models/openai"; const base = chatgpt(${JSON.stringify(options.model)});`}
import { appendFileSync } from "node:fs";
const allowed = new Set(${JSON.stringify([...options.allowedTools, ...options.deniedTools].map((t) => `${prefix}${t}`))});
const record = value => appendFileSync(${JSON.stringify(observed)}, JSON.stringify(value) + "\\n");
export default { specificationVersion: base.specificationVersion, provider: base.provider, modelId: base.modelId, supportedUrls: base.supportedUrls,
 async doGenerate() { throw new Error("Eve eval requires streaming"); },
 async doStream(input) {
  const tools = (input.tools ?? []).map(t => t.name);
  record({ type: "inventory", tools });
  if (!tools.includes("eve__search") || !tools.includes("eve__tool") || tools.some(t => !allowed.has(t) && !["eve__search", "eve__tool"].includes(t))) throw new Error("Unexpected tool inventory outside the fake MCP config: " + tools.join(","));
  const result = await base.doStream(input);
  return { ...result, stream: result.stream.pipeThrough(new TransformStream({ transform(chunk, out) {
   // Eve emits no event for a deferred name it cannot resolve; only the model's own call shows it.
   if (chunk.type === "tool-call" && chunk.toolName === "eve__tool") record({ type: "deferred", id: chunk.toolCallId, input: chunk.input });
   if (chunk.type === "response-metadata") { record({ type: "served", model: chunk.modelId }); if (chunk.modelId !== base.modelId) throw new Error("Eve served " + chunk.modelId + " instead of " + base.modelId); }
   out.enqueue(chunk);
  } })) };
 }
};`,
    );
    await writeFile(
      join(root, "agent/agent.ts"),
      'import { defineAgent } from "eve"; import model from "../model.mjs"; export default defineAgent({ model, defaultTools: false, modelContextWindowTokens: 128000 });',
    );
    const reservation = await serveFetch(async () => new Response());
    const port = reservation.port;
    await reservation.close();
    // startProcess owns the detached group. Bootstrap clears inherited keys,
    // provider overrides and CODEX_HOME before Eve or app-server is imported.
    await writeFile(
      join(root, "boot.mjs"),
      `
const keep = new Set(["PATH", "HOME", "USER", "TMPDIR", "TZ", "CONNECTA_ACCESS_TOKEN"]);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
process.env.DO_NOT_TRACK = "1"; process.env.EVE_TELEMETRY_DISABLED = "1";
process.argv[1] = new URL("eve/bin/eve.js").pathname;
await import("eve/bin/eve.js");
`.replaceAll('"eve/bin/eve.js"', JSON.stringify(pathToFileURL(join(helper, "node_modules/eve/bin/eve.js")).href)),
    );
    const argv = [
      join(root, "boot.mjs"),
      "dev",
      "--no-ui",
      "--no-default-extensions",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ];
    server = startProcess(process.execPath, argv, { cwd: root, env: { CONNECTA_ACCESS_TOKEN: options.token } });
    const { Client } = await import(pathToFileURL(requireEve.resolve("eve/client")).href);
    const client = new Client({ baseUrl: `http://127.0.0.1:${port}` });
    const bootDeadline = Math.min(Date.now() + 120_000, Date.now() + options.timeoutMs);
    for (;;) {
      signal.throwIfAborted();
      if (server.child.exitCode !== null || server.child.signalCode !== null || Date.now() > bootDeadline)
        throw new Error(`Eve failed to start: ${server.output()}`);
      try {
        await client.health({ signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    push({
      type: "system",
      subtype: "init",
      model: options.model,
      agent_version: eveVersion(),
      tools: loadedTools,
    });
    // Every Eve deferred search is observed, so zero host searches is a measurement.
    push({ type: "host_raw_observed" });
    const { session } = await client.sessions.create({ signal });
    const calls = new Set<string>();
    const settledDeferred = new Set<string>();
    // A mistaken name never reaches call.requested. Record it where the model saw
    // the refusal, because such an error is what a connection guide should prevent.
    const recordUnresolvedDeferred = async () => {
      const lines = (await readFile(observed, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line) as { type: string; id?: string; input?: unknown };
        if (entry.type !== "deferred" || !entry.id || calls.has(entry.id) || settledDeferred.has(entry.id)) continue;
        settledDeferred.add(entry.id);
        let input = entry.input as { name?: unknown; input?: unknown } | string | undefined;
        try {
          if (typeof input === "string") input = JSON.parse(input) as { name?: unknown; input?: unknown };
        } catch {
          // A malformed call is still a refused attempt; its raw text stays in the trace.
        }
        push({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: entry.id, name: "eve__tool", input }] },
        });
        push({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: entry.id,
                is_error: true,
                content: [
                  {
                    type: "text",
                    text: `Eve could not resolve deferred tool ${typeof input === "object" ? String(input?.name) : "(unparsed call)"}`,
                  },
                ],
              },
            ],
          },
        });
      }
    };
    let prompt: string | undefined = options.firstPrompt;
    let turn = 0;
    let servedCount = 0;
    while (prompt !== undefined) {
      signal.throwIfAborted();
      turnStarts.push(events.length);
      let modelTurns = 0;
      const delivery = await session.send(prompt, { signal });
      const streamed = (async () => {
        for await (const event of delivery.stream({ signal })) {
          const data = event.data;
          if (event.type === "model.started") modelTurns++;
          if (event.type === "interaction.opened")
            throw new Error(`Unexpected Eve approval/auth interaction: ${JSON.stringify(data.request)}`);
          if (event.type === "model.started" && data.modelId.split("/").at(-1) !== options.model)
            throw new Error(`Eve requested ${data.modelId} instead of ${options.model}`);
          if (event.type === "call.requested") {
            const name = data.capability.name;
            // Eve records the resolved inner tool name for deferred calls.
            const input = data.input ?? {};
            const inner = name === "eve__tool" ? input.name : name;
            const args = name === "eve__tool" ? input.input : input;
            const strip = (tool: string) => (tool.startsWith(prefix) ? tool.slice(prefix.length) : tool);
            if (inner !== "eve__search" && !(typeof inner === "string" && loadedTools.includes(toolId(strip(inner)))))
              throw new Error(`Unexpected Eve tool: ${String(inner)}`);
            calls.add(data.callId);
            push({
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: data.callId,
                    name: inner === "eve__search" ? inner : toolId(strip(inner)),
                    input: args,
                  },
                ],
              },
            });
          }
          if (event.type === "call.settled" && calls.has(data.callId)) {
            if (data.outputRef) throw new Error("Eve result reference cannot establish delivered data");
            const output = data.output;
            if (data.outcome === "rejected") push({ type: "codex_denial", tool: data.callId });
            push({
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: data.callId,
                    is_error: data.outcome !== "completed" || output?.isError === true,
                    // A host rejection is one refused attempt, whatever Eve's own wording.
                    content:
                      data.outcome === "rejected"
                        ? [
                            {
                              type: "text",
                              text: `Host refused this tool call: permission denied. ${JSON.stringify(data.error ?? output)}`,
                            },
                          ]
                        : (output?.content ?? [{ type: "text", text: JSON.stringify(data.error ?? output) }]),
                  },
                ],
              },
            });
          }
          if (event.type === "call.settled") {
            const unavailable = data.output?.unavailable;
            const authMessage = /requires authorization and cannot start interactive sign-in/i;
            if (
              (Array.isArray(unavailable) &&
                unavailable.some((entry) => entry.connection === connectionName && authMessage.test(entry.error))) ||
              (data.output?.code === "ACTION_RESULT_FAILED" && authMessage.test(data.output.message)) ||
              authMessage.test(data.error?.message)
            )
              throw new Error(
                `authentication failure: Eve's ${connectionName} connection requires authorization and cannot start interactive sign-in`,
              );
          }
          if (event.type === "usage.recorded") push({ type: "eve_usage", usage: data.usage });
          if (event.type === "model.settled") await recordUnresolvedDeferred();
          if (event.type === "content.completed" && data.kind === "text")
            push({
              type: "assistant",
              message: {
                phase: data.phase === "reply" ? "final_answer" : "commentary",
                content: [{ type: "text", text: data.value }],
              },
            });
        }
      })();
      const [result] = await Promise.all([delivery.result({ signal }), streamed]);
      if (result.status !== "completed")
        throw new Error(`Eve conversation ${result.status}: ${JSON.stringify(result.error ?? result.interactions)}`);
      const observations = (await readFile(observed, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const served = observations.filter((o) => o.type === "served");
      if (served.length <= servedCount || served.some((o) => o.model !== options.model))
        throw new Error("Eve served model inventory could not be verified");
      servedCount = served.length;
      model = served.at(-1).model;
      push({ type: "result", subtype: "success", num_turns: modelTurns });
      turn++;
      prompt = await Promise.race([
        options.nextTurn(turn, events),
        new Promise<undefined>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
      ]);
    }
  } catch (error) {
    exitCode = 1;
    push({
      type: "result",
      subtype: "error",
      result: (/ChatGPT.*(?:sign.in|signed|auth)|chatgpt-sub|Codex app-server is unavailable/i.test(String(error))
        ? `authentication failure: ${String(error)}`
        : String(error)
      ).replaceAll(options.token, "<redacted>"),
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
    try {
      if (server) {
        await stopProcess(server.child);
        stderrTail = server.output().replaceAll(options.token, "<redacted>");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  return {
    events,
    turnStarts,
    exitCode,
    timedOut,
    aborted: options.signal?.aborted ?? false,
    stderrTail,
    wallMs: Math.round(performance.now() - started),
    argv: ["eve", "dev", "--no-ui", "--no-default-extensions"],
    model,
    loadedTools,
  };
}
