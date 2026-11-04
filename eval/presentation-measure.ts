/**
 * Exact, model-free sizes for the presentation arms on the Worker target: what
 * each deployment serves, what Codex's first request and first discovery carry,
 * and what each schema format and clone folding cost per page. Run
 * `pnpm exec tsx eval/presentation-measure.ts` after building.
 *
 * Claude Code never shows `outputSchema` to the model, so its cost comes from
 * paid trials' first-request tokens. Codex lists MCP tools only through
 * `ALL_TOOLS`, so its cost lands on first discovery. Eve renders each signature
 * with its own `renderToolSignature`; `--eve` loads it from an Eve install:
 * packages/connecta-eve/node_modules/eve/dist/src/tools/signature.js.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCodex } from "./agent/codex.js";
import { connectorLine, presentationOf, type PresentationArm } from "./deploy/presentation.js";
import { startDeployment } from "./deploy/targets.js";
import { NO_INJECTION } from "./fakes/injection.js";
import { World } from "./fakes/world.js";
import { presentationSession } from "./presentation-session.js";
import { connectMcp } from "./support/mcp.js";
import { flags } from "./support/meta.js";
import { serveFetch } from "./support/serve.js";
import type { ActiveTask } from "./tasks/types.js";

const utf8 = new TextEncoder();
const size = (value: unknown) => utf8.encode(typeof value === "string" ? value : JSON.stringify(value)).length;
const CATALOG = 300;
const OUTPUT_ARMS: PresentationArm[] = ["control", "output-slim", "output-none"];
const evePath = flags(process.argv.slice(2)).get("eve");
const eve = evePath
  ? ((await import(resolve(evePath))) as { renderToolSignature(tool: Record<string, unknown>): string })
  : undefined;

console.log("## Served tool list, by output arm (bytes)\n");
console.log(
  "| Arm | tools/list | execute_code output | search_tools output | skills output | authorize_connector output | Eve signatures, six tools |",
);
console.log("|---|---|---|---|---|---|---|");
for (const arm of OUTPUT_ARMS) {
  const session = await presentationSession(arm, "worker", undefined, CATALOG);
  try {
    const { tools } = await session.client.listTools();
    const output = (name: string) => {
      const schema = tools.find((tool) => tool.name === name)?.outputSchema;
      return schema ? size(schema) : 0;
    };
    const signatures = eve
      ? tools.reduce(
          (total, { name, inputSchema, outputSchema }) =>
            total + size(eve.renderToolSignature({ name, inputSchema, outputSchema })),
          0,
        )
      : "n/a";
    console.log(
      `| ${arm} | ${size({ tools })} | ${output("execute_code")} | ${output("search_tools")} | ${output("skills")} | ${output("authorize_connector")} | ${signatures} |`,
    );
  } finally {
    await session.close();
  }
}

console.log("\n## Codex, by output arm (local scripted model, no paid model)\n");
console.log("| Arm | First request bytes | First discovery bytes (ALL_TOOLS output) | Purpose lines in discovery |");
console.log("|---|---|---|---|");
const root = await mkdtemp(join(tmpdir(), "connecta-presentation-"));
try {
  const authFile = join(root, "auth.json");
  await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: "sk-fake-local-measure-only" }));
  const CONNECTOR_ARMS: PresentationArm[] = ["connectors-id", "connectors-purpose"];
  for (const arm of [...OUTPUT_ARMS, ...CONNECTOR_ARMS]) {
    const worldOptions = CONNECTOR_ARMS.includes(arm) ? { presentationFake: "crm" as const } : {};
    const world = new World(worldOptions, { ...NO_INJECTION, catalogTools: CATALOG });
    await world.start();
    const requests: { input?: { type?: string }[] }[] = [];
    const model = await serveFetch(async (request) => {
      requests.push((await request.json()) as (typeof requests)[number]);
      const item =
        requests.length === 1
          ? {
              type: "custom_tool_call",
              id: "ctc_measure",
              call_id: "call_measure",
              name: "exec",
              namespace: "functions",
              input: "text(JSON.stringify(ALL_TOOLS));",
            }
          : {
              type: "message",
              id: "msg_measure",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Measured.", annotations: [] }],
            };
      const response = {
        id: `resp_measure_${requests.length}`,
        object: "response",
        status: "completed",
        model: "gpt-6.1-sol",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
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
    });
    const deployment = await startDeployment(
      "worker",
      world,
      { id: "measure", world: worldOptions } as ActiveTask,
      "six",
      arm,
    );
    const mcp = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
    try {
      const tools = await mcp.listTools();
      const wrapper = join(root, `codex-${arm}.cjs`);
      await writeFile(
        wrapper,
        `#!/usr/bin/env node\nconst fs=require('node:fs');const p=require('node:path').join(process.env.CODEX_HOME,'config.toml');fs.writeFileSync(p,'model_provider = "fidelity"\\n'+fs.readFileSync(p,'utf8')+'\\n[model_providers.fidelity]\\nname = "fidelity"\\nbase_url = "${model.url}/v1"\\nwire_api = "responses"\\nrequires_openai_auth = false\\n');const c=require('node:child_process').spawn('codex',['app-server','--stdio'],{stdio:'inherit'});process.on('SIGTERM',()=>c.kill('SIGTERM'));c.on('exit',code=>process.exit(code??1));`,
        { mode: 0o700 },
      );
      await runCodex({
        model: "gpt-6.1-sol",
        surface: "six",
        mcpUrl: deployment.mcpUrl,
        token: deployment.token,
        allowedTools: tools.map((tool) => tool.name),
        deniedTools: [],
        timeoutMs: 60_000,
        effort: "high",
        firstPrompt: "List tools.",
        nextTurn: async () => undefined,
        testHost: { executable: wrapper, args: [], authFile, version: "codex-cli 0.166.0" },
      });
      const outputs = (requests[1]?.input ?? []).filter((item) => /output/.test(item.type ?? ""));
      const lines = JSON.stringify(outputs).split("Self-serve small-business").length - 1;
      console.log(`| ${arm} | ${size(requests[0] ?? {})} | ${size(outputs)} | ${lines} |`);
    } finally {
      await mcp.close();
      await deployment.close();
      await model.close();
      await world.stop();
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("\n## One discovery page, by schema format, bytes (top-level search_tools; default limit)\n");
console.log("| Query | none | compact | typescript | json |");
console.log("|---|---|---|---|---|");
{
  const session = await presentationSession("control", "worker", undefined, CATALOG);
  try {
    for (const args of [
      { query: "search issues" },
      { query: "list accounts" },
      { query: "post message" },
      { query: "search issues", connector: "tracker" },
    ]) {
      const cells: number[] = [];
      for (const includeSchemas of [undefined, "compact", "typescript", "json"]) {
        const page = await session.search({ ...args, ...(includeSchemas ? { includeSchemas } : {}) });
        cells.push(size(page));
      }
      console.log(`| ${JSON.stringify(args)} | ${cells.join(" | ")} |`);
    }
    const addresses = ["tracker.search_issues", "chat.post_message", "analytics.get_account_metrics"];
    const described = await session.program(`async () => {
      const out = {};
      for (const format of ["compact", "typescript", "json"])
        out[format] = JSON.stringify(await connecta.describe({ addresses: ${JSON.stringify(addresses)}, format })).length;
      return out;
    }`);
    console.log(`\nDescribe of ${addresses.length} tools, bytes: ${JSON.stringify(described.result)}`);
  } finally {
    await session.close();
  }
}

console.log("\n## Clone folding on the clone-heavy pool\n");
console.log("| Query | Arm | Rows | Distinct tools | Page bytes | Total |");
console.log("|---|---|---|---|---|---|");
for (const arm of ["control", "clones-collapsed"] as PresentationArm[]) {
  const session = await presentationSession(arm, "worker", "clones", CATALOG);
  try {
    for (const query of ["invoice", "list tickets", "create note", "contact email", ""]) {
      const page = await session.search({ query, includeSchemas: "compact" });
      const rows = page.tools as { name: string; description?: string }[];
      const distinct = new Set(rows.map((row) => `${row.name}\0${row.description}`)).size;
      console.log(
        `| ${JSON.stringify(query)} | ${arm} | ${rows.length} | ${distinct} | ${size(page)} | ${page.total} |`,
      );
    }
  } finally {
    await session.close();
  }
}

console.log("\n## Connector line, bytes\n");
{
  const world = new World({ presentationFake: "crm" }, { ...NO_INJECTION, catalogTools: CATALOG });
  await world.start();
  try {
    for (const arm of ["connectors-id", "connectors-purpose"] as PresentationArm[]) {
      const line = connectorLine(presentationOf(arm, world.connectorSpecs()));
      console.log(`- ${arm}: ${size(line)} bytes, once each in instructions and the execute_code inventory`);
      console.log(`  ${line}`);
    }
  } finally {
    await world.stop();
  }
}
