/**
 * Model-free controls for the presentation arms, through a real SDK client and
 * deployment on Node and Worker. The SDK client validates structured results
 * against the served outputSchema, so an arm that breaks a contract fails here.
 * Run with `pnpm run eval:selftest --presentation-only` after building.
 */
import { Validator } from "@cfworker/json-schema";
import { compare, crossTarget } from "./compare.js";
import {
  boundedPurpose,
  collapsedSearch,
  connectorLine,
  forPresentation,
  parsePresentation,
  presentationOf,
  presentationRefusal,
  presentedGuestCall,
  type PresentationArm,
} from "./deploy/presentation.js";
import type { Target } from "./deploy/targets.js";
import { NO_INJECTION } from "./fakes/injection.js";
import { World } from "./fakes/world.js";
import { PRESENTATION_PLAN, plannedBatches } from "./presentation-plan.js";
import { presentationProvenance } from "./presentation-report.js";
import { presentationSession } from "./presentation-session.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import type { AgentResultFile } from "./report/summary.js";

const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(`Presentation control failed: ${message}`);
};
const DISCOVERY_WORLD = ACTIVE_TASKS.find((task) => task.id === "discovery-lookalike-crm")!.world!.discovery!;
const refuses = (run: () => unknown, pattern: RegExp, message: string) => {
  try {
    run();
  } catch (error) {
    assert(pattern.test(String(error)), `${message}: ${String(error)}`);
    return;
  }
  throw new Error(`Presentation control failed: ${message} was not refused`);
};

// ----------------------------------------------------------- parsing and refusal

assert(parsePresentation(undefined) === "control", "control is the default");
refuses(() => parsePresentation("schema-yaml"), /--presentation must be/, "an unknown arm");
assert(presentationRefusal("schema-json", "native", "outcome"), "a schema arm off the six surface");
assert(presentationRefusal("schema-json", "six", "route"), "a schema arm on route grading");
assert(!presentationRefusal("control", "native", "route"), "control runs anywhere");
assert(!presentationRefusal("schema-json", "six", "outcome"), "an arm runs on six/outcome");
for (const batch of plannedBatches())
  for (const task of batch.tasks)
    assert(
      ACTIVE_TASKS.some((t) => t.id === task),
      `planned task ${task} exists`,
    );
{
  const trials = plannedBatches().reduce((n, batch) => n + batch.tasks.length, 0) * PRESENTATION_PLAN.repeats * 2;
  assert(trials <= 150, `the plan fits the 150-trial budget, got ${trials}`);
  console.log(`ok   plan: ${plannedBatches().length} batches per runner, ${trials} trials`);
}
console.log("ok   unknown arms and arms off the six outcome surface are refused");

// ----------------------------------------------------------- control is the product

{
  const connecta = { fetch: async () => new Response() } as never;
  assert(forPresentation(connecta, undefined) === connecta, "no arm leaves the deployment untouched");
  assert(
    forPresentation(connecta, { arm: "control", connectors: [] }) === connecta,
    "the control arm leaves the deployment untouched",
  );
  const seen: unknown[][] = [];
  const fn = async (...args: unknown[]) => (seen.push(args), { args });
  const original = { query: "x" };
  await presentedGuestCall({ arm: "control", connectors: [] }, "connecta.search", fn, [original]);
  assert(seen[0]![0] === original, "the control arm passes guest arguments through by identity");
  console.log("ok   the control arm wraps nothing");
}

// ----------------------------------------------------------- compare refusals

{
  const file = (presentation: PresentationArm | undefined, target = "worker"): AgentResultFile =>
    ({
      kind: "connecta-eval/agent",
      version: 1,
      meta: {},
      config: { models: ["m"], repeats: 1, tasks: ["t"], target, ...(presentation ? { presentation } : {}) },
      tasks: [],
      planned: [],
      skipped: [],
      trials: [],
    }) as unknown as AgentResultFile;
  for (const options of [{}, { allowMismatch: true }])
    refuses(
      () => compare(file("schema-json"), file("control"), options),
      /different presentations/,
      "compare across presentation arms",
    );
  refuses(
    () => compare(file(undefined), file("output-none"), { allowMismatch: true }),
    /different presentations/,
    "a historical file against an arm",
  );
  refuses(() => crossTarget(file("schema-json", "node"), file("control")), /presentation arm/, "cross-target arms");
  const reasons = presentationProvenance([file("control"), file("schema-json")]);
  assert(
    reasons.some((r) => /known source|protocol/.test(r)),
    "the report requires measured provenance",
  );
  console.log(
    "ok   compare refuses mixed presentation arms even with --allow-mismatch; the report requires provenance",
  );
}

// ----------------------------------------------------------- pure folding rules

{
  const row = (address: string, name: string) => ({ name, address, description: "d" });
  let requests = 0;
  const run = async (args: Record<string, unknown>) => {
    requests++;
    const all = ["a", "b", "c"].flatMap((name) => ["x", "y"].map((c) => row(`${c}.${name}`, name)));
    const offset = (args.offset as number | undefined) ?? 0;
    const tools = all.slice(offset, offset + (args.limit as number));
    return { catalogErrors: [], tools, total: all.length, offset, limit: args.limit as number, hasMore: false };
  };
  const first = await collapsedSearch({ limit: 2 }, run);
  assert(first.tools.length === 2 && first.hasMore && first.nextOffset === 2, "a folded page keeps its limit");
  assert((first.tools[0]!.alsoAt as string[])[0] === "y.a", "alsoAt lists the same tool's other addresses");
  assert(first.total === 3, "the total counts folded rows");
  const second = await collapsedSearch({ limit: 2, offset: 2 }, run);
  assert(second.tools.length === 1 && !second.hasMore && second.tools[0]!.name === "c", "the last folded page ends");
  requests = 0;
  const scoped = await collapsedSearch({ connector: "x", limit: 2 }, run);
  assert(requests === 1 && scoped.limit === 2 && scoped.tools.length === 2, "a scoped search passes straight through");
  assert(boundedPurpose(`${"word ".repeat(40)}end.`).length <= 60, "a purpose is bounded");
  const bounded = connectorLine(
    presentationOf(
      "connectors-purpose",
      Array.from({ length: 30 }, (_, i) => ({
        id: `connector_${i}`,
        description: "A purpose of about fifty bytes in length.",
      })),
    ),
  );
  assert(bounded.length <= 1024 && bounded.includes("connector_29"), "detail gives way before names within the cap");
  const guided = presentationOf("connectors-id", [{ id: "a", description: "d", usageGuide: "# guide" }]);
  assert(
    connectorLine(guided).includes('guide: skills({name:"connector:a"})'),
    "both connector arms keep guide pointers",
  );
  const discovery = new World({ discovery: DISCOVERY_WORLD }, NO_INJECTION);
  await discovery.start();
  const twins = connectorLine(presentationOf("connectors-purpose", discovery.connectorSpecs()));
  await discovery.stop();
  assert(/salesdesk \(Retired/.test(twins), `the look-alike purpose survives the cap: ${twins}`);
  console.log("ok   folding pages, totals, scoped pass-through and inventory cap");
}

// ----------------------------------------------------------- real deployments

const SCHEMA_FIELD = { compact: "text", typescript: "signature", json: "json" } as const;
for (const target of ["node", "worker"] as Target[]) {
  for (const [arm, format] of [
    ["schema-compact", "compact"],
    ["schema-typescript", "typescript"],
    ["schema-json", "json"],
  ] as const) {
    const session = await presentationSession(arm, target);
    try {
      const { tools } = await session.client.listTools();
      const execute = tools.find((tool) => tool.name === "execute_code")!;
      const search = tools.find((tool) => tool.name === "search_tools")!;
      assert(!execute.description!.includes("Search shows a TypeScript"), `${arm} restates the program default`);
      assert(!search.description!.includes('includeSchemas="compact"'), `${arm} restates the search_tools default`);
      const wire = await session.search({ query: "search issues", connector: "tracker" });
      const row = wire.tools[0];
      const shape = (entry: Record<string, unknown>) =>
        typeof entry.signature === "string" ? "signature" : typeof entry.inputSchema === "object" ? "json" : "text";
      assert(shape(row) === SCHEMA_FIELD[format], `${arm} top-level default, got ${JSON.stringify(row)}`);
      const explicit = await session.search({ query: "search issues", connector: "tracker", includeSchemas: "json" });
      assert(shape(explicit.tools[0]) === "json", `${arm} honors an explicit top-level format`);
      const program = await session.program(`async () => {
        const found = await connecta.search({ query: "search issues", connector: "tracker" });
        const described = await connecta.describe({ addresses: ["tracker.search_issues"] });
        const pinned = await connecta.describe({ addresses: ["tracker.search_issues"], format: "json" });
        const usage = await connecta.skill("usage");
        return { row: found.tools[0], described: described.tools[0], pinned: pinned.tools[0], usage: usage.text };
      }`);
      assert(shape(program.result.row) === SCHEMA_FIELD[format], `${arm} connecta.search default`);
      assert(shape(program.result.described) === SCHEMA_FIELD[format], `${arm} connecta.describe default`);
      assert(shape(program.result.pinned) === "json", `${arm} honors an explicit describe format`);
      assert(!/Search defaults to a\s+TypeScript/.test(program.result.usage), `${arm} usage states the arm's default`);
    } finally {
      await session.close();
    }
  }
  console.log(`ok   ${target}: schema arms change the default on both routes and honor explicit formats`);

  for (const arm of ["output-slim", "output-none"] as const) {
    const session = await presentationSession(arm, target);
    try {
      const { tools } = await session.client.listTools();
      const advertising = tools.filter((tool) => tool.outputSchema);
      assert(arm === "output-none" ? advertising.length === 0 : advertising.length === 4, `${arm} advertises the arm`);
      // The SDK client validates against the served schema, so these calls also prove conformance.
      const results = await Promise.all([
        session.client.callTool({ name: "search_tools", arguments: { query: "issues" } }),
        session.client.callTool({ name: "search_tools", arguments: { connector: "no_such_connector" } }),
        session.client.callTool({ name: "skills", arguments: {} }),
        session.client.callTool({ name: "skills", arguments: { name: "usage" } }),
        session.client.callTool({ name: "execute_code", arguments: { code: "async () => 1" } }),
        session.client.callTool({ name: "execute_code", arguments: { code: "async () => { throw new Error('x'); }" } }),
        session.client.callTool({ name: "authorize_connector", arguments: { connector: "billing" } }),
      ]);
      for (const [index, result] of results.entries()) {
        assert(result.structuredContent !== undefined, `${arm} result ${index} keeps structuredContent`);
        assert((result.content as unknown[]).length > 0, `${arm} result ${index} keeps its text block`);
      }
      if (arm === "output-slim") {
        const byName = new Map(advertising.map((tool) => [tool.name, tool.outputSchema]));
        for (const [name, result] of [
          ["search_tools", results[0]],
          ["skills", results[2]],
          ["execute_code", results[4]],
          ["authorize_connector", results[6]],
        ] as const)
          assert(
            new Validator(byName.get(name) as never).validate(result!.structuredContent).valid,
            `${name} validates against its slim schema`,
          );
      }
    } finally {
      await session.close();
    }
  }
  console.log(`ok   ${target}: output arms advertise as declared and structured results still validate`);

  for (const arm of ["connectors-id", "connectors-purpose"] as const) {
    const session = await presentationSession(arm, target, "payments", 60);
    try {
      const { tools } = await session.client.listTools();
      const execute = tools.find((tool) => tool.name === "execute_code")!;
      const instructions = session.client.getInstructions() ?? "";
      for (const text of [execute.description!, instructions]) {
        assert(text.includes("payments_a"), `${arm} names the connector`);
        assert(
          text.includes("Production: real customers") === (arm === "connectors-purpose"),
          `${arm} serves its purpose line`,
        );
      }
      const page = await session.search({ query: "refund" });
      const facts = JSON.stringify(page.connectors ?? {});
      assert(!/sandbox|production/i.test(facts), `${arm} leaves no purpose in search pages: ${facts}`);
    } finally {
      await session.close();
    }
  }
  console.log(`ok   ${target}: connector arms differ only in the purpose line of instructions and inventory`);

  {
    const flat = await presentationSession("control", target, "clones", 60);
    const folded = await presentationSession("clones-collapsed", target, "clones", 60);
    try {
      const flatPage = await flat.search({ query: "invoice", limit: 8 });
      const page = await folded.search({ query: "invoice", limit: 8 });
      const distinct = (rows: { name: string }[]) => new Set(rows.map((row) => row.name)).size;
      assert(distinct(page.tools) > distinct(flatPage.tools), "folding shows more distinct tools per page");
      assert(page.tools.length === 8 || !page.hasMore, "a folded page keeps its limit");
      // Padding rows are not clones: their descriptions name their own workspace.
      const clones = page.tools.filter((row: { address: string }) => row.address.startsWith("crm_"));
      assert(clones.length > 0, "the page holds cloned rows");
      assert(
        clones.every((row: { alsoAt?: string[] }) => row.alsoAt?.length === 3),
        "each cloned row names its three other tenants",
      );
      const guest = await folded.program(
        `async () => await connecta.search({ query: "invoice", limit: 8, includeSchemas: "compact" })`,
      );
      assert(distinct(guest.result.tools) === guest.result.tools.length, "program pages fold too");
      // Every clone is reachable by paging, exactly once.
      const seen: string[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const next: Record<string, any> = await folded.search({ query: "invoice", limit: 5, offset });
        seen.push(...next.tools.map((row: { address: string }) => row.address));
        offset = next.nextOffset;
      }
      assert(new Set(seen).size === seen.length, "paging repeats no folded row");
      // Scoped search and calls are unchanged.
      const scopedFlat = await flat.search({ query: "invoice", connector: "crm_west", limit: 8 });
      const scoped = await folded.search({ query: "invoice", connector: "crm_west", limit: 8 });
      assert(JSON.stringify(scoped) === JSON.stringify(scopedFlat), "scoped search is byte-identical");
      const west = page.tools
        .flatMap((row: { address: string; alsoAt?: string[] }) => [row.address, ...(row.alsoAt ?? [])])
        .find((address: string) => address === "crm_west.get_invoice");
      assert(west, "alsoAt names the tenant's own address");
      const before = folded.world.ledger.calls.length;
      const call = await folded.client.callTool({
        name: "call_tool",
        arguments: { address: west, args: { invoiceNumber: "INV-2044" } },
      });
      assert(!call.isError && /18250/.test(JSON.stringify(call.content)), "an alsoAt address reaches its own tenant");
      const landed = folded.world.ledger.calls.slice(before);
      assert(landed.length === 1 && landed[0]!.service === "crm_west", "the call lands on that tenant alone");
    } finally {
      await flat.close();
      await folded.close();
    }
    console.log(`ok   ${target}: clone folding pages cleanly, leaves scoped search and calls unchanged`);
  }
}
console.log("ok   presentation arms");
