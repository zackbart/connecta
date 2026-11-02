/** Observe the pinned CLI's first model request against a local rejecting model. No paid model. */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  for (const surface of ["six", "native", "native-no-code"] as Surface[]) {
    const world = new World();
    await world.start();
    const model = await serveFetch(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      observations.push({ surface, path: new URL(request.url).pathname, body });
      return Response.json(
        { error: { message: "Intentional fidelity capture; no real model", type: "invalid_request_error" } },
        { status: 401 },
      );
    });
    let deployment;
    let mcp;
    try {
      deployment = await startWorkerDeployment(world.connectorSpecs(), {}, [], 0, surface);
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
        JSON.stringify({ surface, loadedTools: run.loadedTools, stderrTail: run.stderrTail, events: run.events }),
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
  for (const surface of ["six", "native", "native-no-code"]) {
    const captured = observations.find((request) => request.surface === surface);
    if (!captured) throw new Error(`Fidelity failed: no ${surface} model request captured`);
    const wire = JSON.stringify(captured.body);
    if (wire.includes("exec_command") || wire.includes('"name":"collaboration"'))
      throw new Error(`Fidelity failed: ${surface} model request exposes outer shell or collaboration tools`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
