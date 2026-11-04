/** Observe the pinned CLI's first model request against a local rejecting model. No paid model. */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTrace } from "./agent/trace.js";
import { NO_INJECTION } from "./fakes/injection.js";
import { World } from "./fakes/world.js";
import { startWorkerDeployment } from "./deploy/worker.js";
import { connectMcp } from "./support/mcp.js";
import { serveFetch } from "./support/serve.js";
import { runCodex } from "./agent/codex.js";
import type { Surface } from "./agent/surface.js";
const root = await mkdtemp(join(tmpdir(), "connecta-fidelity-"));
const observations: { surface: Surface; path: string; body: Record<string, unknown> }[] = [];
try {
  const authFile = join(root, "auth.json");
  await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: "sk-fake-local-fidelity-only" }));
  for (const surface of ["six", "five", "native", "native-no-code"] as Surface[]) {
    const world = new World({}, { ...NO_INJECTION, catalogTools: 300 });
    await world.start();
    let responses = 0;
    const model = await serveFetch(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      observations.push({ surface, path: new URL(request.url).pathname, body });
      const scripted = process.argv.includes("--events");
      if (scripted) {
        const first = responses++ === 0;
        const item = first
          ? {
              type: "custom_tool_call",
              id: "ctc_fidelity",
              call_id: "call_fidelity",
              name: "exec",
              namespace: "functions",
              input: "text(ALL_TOOLS.map(t => t.name));",
            }
          : {
              type: "message",
              id: "msg_fidelity",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Fidelity event captured.", annotations: [] }],
            };
        const response = {
          id: `resp_fidelity_${responses}`,
          object: "response",
          status: "completed",
          model: "gpt-6.1-sol",
          output: [item],
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
            input_tokens_details: { cached_tokens: 0 },
          },
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
              (event, sequence_number) =>
                `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json(
        { error: { message: "Intentional fidelity capture; no real model", type: "invalid_request_error" } },
        { status: 401 },
      );
    });
    let deployment;
    let mcp;
    try {
      deployment = await startWorkerDeployment(world.connectorSpecs(), {}, world.injected.ids(), 0, surface);
      mcp = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
      const tools = await mcp.listTools();
      const wrapper = join(root, `codex-${surface}.cjs`);
      await writeFile(
        wrapper,
        `#!/usr/bin/env node\nconst fs=require('node:fs');const p=require('node:path').join(process.env.CODEX_HOME,'config.toml');fs.writeFileSync(p,'model_provider = "fidelity"\\n'+fs.readFileSync(p,'utf8')+'\\n[model_providers.fidelity]\\nname = "fidelity"\\nbase_url = "${model.url}/v1"\\nwire_api = "responses"\\nrequires_openai_auth = false\\n');const c=require('node:child_process').spawn('codex',['app-server','--stdio'],{stdio:'inherit'});process.on('SIGTERM',()=>c.kill('SIGTERM'));c.on('exit',code=>process.exit(code??1));`,
        { mode: 0o700 },
      );
      const run = await runCodex({
        model: "gpt-6.1-sol",
        surface,
        mcpUrl: deployment.mcpUrl,
        token: deployment.token,
        allowedTools: tools.map((tool) => tool.name),
        deniedTools: [],
        timeoutMs: 30000,
        effort: "high",
        firstPrompt: "Read ci.get_run for runId 4812 and report its status and commit.",
        nextTurn: async () => undefined,
        testHost: { executable: wrapper, args: [], authFile, version: "codex-cli 0.166.0" },
      });
      console.log(
        JSON.stringify({
          surface,
          loadedTools: run.loadedTools,
          stderrTail: run.stderrTail,
          events: run.events,
          hostSearchCalls: parseTrace(run.events, run.turnStarts, []).hostSearchCalls,
        }),
      );
    } finally {
      await mcp?.close();
      await deployment?.close();
      await model.close();
      await world.stop();
    }
  }
  console.log(JSON.stringify({ modelRequests: observations }, null, 2));
  if (observations.length === 0) throw new Error("Fidelity failed: no model request captured");
  for (const surface of ["six", "five", "native", "native-no-code"]) {
    const captured = observations.find((request) => request.surface === surface);
    if (!captured) throw new Error(`Fidelity failed: no ${surface} model request captured`);
    const definitions: string[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const object = value as Record<string, unknown>;
      if (["custom", "function", "namespace"].includes(String(object.type)) && typeof object.name === "string")
        definitions.push(object.name);
      for (const [key, item] of Object.entries(object)) if (key !== "description") visit(item);
    };
    visit(captured.body);
    if (definitions.includes("exec_command") || definitions.includes("collaboration"))
      throw new Error(`Fidelity failed: ${surface} model request exposes outer shell or collaboration tools`);
    if (!definitions.includes("exec")) throw new Error(`Fidelity failed: ${surface} lacks host exec`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
