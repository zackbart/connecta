/**
 * `pnpm exec tsx eval/measure-descriptions.ts [--out path]` measures what each
 * description arm serves, without a model. It boots the Node deployment once per
 * arm and provider and reads the same wire a host reads: native `tools/list`,
 * and `search_tools` on the meta surface. It also calls `<prefix>_api_details`
 * on every hatch example, proving each example names a real indexed operation.
 */
import { writeFile } from "node:fs/promises";
import { DESCRIPTION_ARMS, exampleArguments, OVERRIDES, type DescriptionArm } from "./deploy/description-arms/index.js";
import { startDeployment } from "./deploy/targets.js";
import { World } from "./fakes/world.js";
import { connectMcp } from "./support/mcp.js";
import { flags } from "./support/meta.js";
import { ACTIVE_TASKS } from "./tasks/index.js";

const utf8 = (text: string) => new TextEncoder().encode(text).length;
/** A writable deployment of each provider, so its whole catalog is served. */
const TASK_BY_PROVIDER: Record<string, string> = {
  stripe: "stripe-step2-refund-recovery",
  github: "github-release-once",
  cloudflare: "cloudflare-step2-purge-once",
  ccb: "ccb-update-recovery",
  quickbooks: "quickbooks-write-journey",
  sheets: "google-sheets-4",
};

export interface ProviderBytes {
  tools: number;
  /** Full description text across the provider's tools. */
  descriptionBytes: number;
  /** Compact JSON of every input schema. */
  schemaBytes: number;
  /** Native `tools/list`: description, schema and name per tool, as served. */
  nativeListBytes: number;
  /** One default `search_tools` hit per tool, as served, on the meta surface. */
  searchHitBytes: number;
  /** The same hit with `includeSchemas: "compact"`, the routing instructions' advice. */
  compactHitBytes: number;
  searchHits: number;
}

async function measure(provider: string, arm: DescriptionArm): Promise<ProviderBytes & { exampleProblems: string[] }> {
  const task = ACTIVE_TASKS.find((entry) => entry.id === TASK_BY_PROVIDER[provider]);
  if (!task) throw new Error(`No planned task for ${provider}`);
  const names = new Set(Object.keys(OVERRIDES[provider]!.tools));
  const open = async (surface: "six" | "native") => {
    const world = new World(task.world);
    await world.start();
    const deployment = await startDeployment("node", world, task, surface, arm);
    const session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
    return {
      session,
      close: async () => {
        await session.close();
        await deployment.close();
        await world.stop();
      },
    };
  };
  const out: ProviderBytes & { exampleProblems: string[] } = {
    tools: 0,
    descriptionBytes: 0,
    schemaBytes: 0,
    nativeListBytes: 0,
    searchHitBytes: 0,
    compactHitBytes: 0,
    searchHits: 0,
    exampleProblems: [],
  };
  const native = await open("native");
  let connector = "";
  try {
    for (const tool of await native.session.listTools()) {
      if (!tool.address) continue;
      const [id, name] = tool.address.split(/\.(.*)/) as [string, string];
      if (!names.has(name) || (connector && id !== connector)) continue;
      connector = id;
      out.tools += 1;
      out.descriptionBytes += utf8(tool.description ?? "");
      const schema = JSON.stringify(tool.inputSchema ?? {});
      out.schemaBytes += utf8(schema);
      out.nativeListBytes += utf8(
        JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }),
      );
    }
  } finally {
    await native.close();
  }
  const meta = await open("six");
  try {
    const hitOf = async (name: string, schemas: boolean) => {
      const result = await meta.session.call("search_tools", {
        query: name,
        connector,
        limit: 8,
        ...(schemas ? { includeSchemas: "compact" } : {}),
      });
      if (result.isError) throw new Error(`search_tools failed for ${name}: ${result.text.slice(0, 300)}`);
      const { tools } = JSON.parse(result.text) as { tools: { name: string }[] };
      return tools.find((entry) => entry.name === name);
    };
    for (const name of names) {
      const hit = await hitOf(name, false);
      const compact = await hitOf(name, true);
      if (!hit || !compact) continue;
      out.searchHitBytes += utf8(JSON.stringify(hit));
      out.compactHitBytes += utf8(JSON.stringify(compact));
      out.searchHits += 1;
    }
    const prefix = [...names].find((name) => name.endsWith("_api_details"))?.replace(/_api_details$/, "");
    if (arm === "example" && prefix) {
      const details = `${connector}.${prefix}_api_details`;
      for (const [tool, entry] of Object.entries(OVERRIDES[provider]!.tools)) {
        if (!/_api_(read|write|upload|details)$/.test(tool)) continue;
        const example = exampleArguments(entry.example) as { method?: string; path?: string };
        const verdict = await meta.session.call("call_tool", {
          address: details,
          args: { method: example.method ?? "GET", path: example.path },
        });
        // QuickBooks needs an operator's consent before any call: checked by hand against its index.
        if (verdict.isError && !verdict.text.includes("downstream_oauth_required"))
          out.exampleProblems.push(`${provider}.${tool}: ${verdict.text.slice(0, 200)}`);
      }
    }
  } finally {
    await meta.close();
  }
  return out;
}

const args = flags(process.argv.slice(2));
const results: Record<string, Record<string, ProviderBytes>> = {};
const problems: string[] = [];
for (const arm of DESCRIPTION_ARMS) {
  results[arm] = {};
  for (const provider of Object.keys(OVERRIDES)) {
    const { exampleProblems, ...bytes } = await measure(provider, arm);
    results[arm]![provider] = bytes;
    problems.push(...exampleProblems);
    console.log(
      `${arm.padEnd(15)} ${provider.padEnd(11)} tools ${bytes.tools}, descriptions ${bytes.descriptionBytes}, schemas ${bytes.schemaBytes}, native list ${bytes.nativeListBytes}, search hits ${bytes.searchHitBytes}, compact hits ${bytes.compactHitBytes} (${bytes.searchHits})`,
    );
  }
  const totals = Object.values(results[arm]!).reduce(
    (sum, row) => ({
      tools: sum.tools + row.tools,
      descriptionBytes: sum.descriptionBytes + row.descriptionBytes,
      schemaBytes: sum.schemaBytes + row.schemaBytes,
      nativeListBytes: sum.nativeListBytes + row.nativeListBytes,
      searchHitBytes: sum.searchHitBytes + row.searchHitBytes,
      compactHitBytes: sum.compactHitBytes + row.compactHitBytes,
      searchHits: sum.searchHits + row.searchHits,
    }),
    {
      tools: 0,
      descriptionBytes: 0,
      schemaBytes: 0,
      nativeListBytes: 0,
      searchHitBytes: 0,
      compactHitBytes: 0,
      searchHits: 0,
    },
  );
  results[arm]!.total = totals;
  console.log(`${arm.padEnd(15)} TOTAL       ${JSON.stringify(totals)}`);
}
if (args.get("out")) await writeFile(args.get("out")!, `${JSON.stringify(results, null, 1)}\n`);
for (const problem of problems) console.error(`example problem: ${problem}`);
process.exit(problems.length ? 1 : 0);
