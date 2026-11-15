import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createMetaTools } from "../src/meta-tools.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, Logger } from "../src/types.js";
import { DEPLOYMENTS, pagingDeployment, type Deployment } from "./retrieval/catalogs.js";
import { HOLDOUT_QUERIES, MAIN_QUERIES, type RetrievalQuery } from "./retrieval/queries.js";
import {
  firstRank,
  gate,
  matchesAnswer,
  MRR_DEPTH,
  queryKey,
  summarize,
  type Metrics,
  type QuerySet,
  type RankedRow,
  type ScoredQuery,
  type Summary,
} from "./retrieval/score.js";
import { flags, ROOT, stamp } from "./support/meta.js";

const args = flags(process.argv.slice(2));
const BASELINE = join(ROOT, "eval", "baselines", "retrieval.json");
const BASE_URL = "https://connecta.test";

interface Baseline {
  summary: Summary;
  ranks: Record<string, string>;
}

interface SearchRow {
  address: string;
  alsoOn?: string[];
}

interface SearchPage {
  tools: SearchRow[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
}

type SearchArgs = { query?: string; connector?: string; safety?: "readOnly"; limit?: number; offset?: number };

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function endpoint(connectors: Connector[]) {
  const registry = new Registry(connectors, { storage: memoryStorage(), logger: silent });
  const tools = createMetaTools(registry, BASE_URL);
  return async (search: SearchArgs): Promise<SearchPage> => {
    const result = await tools.searchTools(search);
    if (result.isError)
      throw new Error(`search_tools ${JSON.stringify(search)} failed: ${JSON.stringify(result.content)}`);
    const page = (result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text)) as SearchPage;
    if (page.tools.length === 0 && page.hasMore)
      throw new Error(`search_tools ${JSON.stringify(search)} returned an empty page with hasMore`);
    return page;
  };
}

type Search = ReturnType<typeof endpoint>;

async function walk(search: Search, base: SearchArgs, max = Infinity): Promise<SearchPage[]> {
  const pages: SearchPage[] = [];
  let offset = 0;
  for (let rows = 0; rows < max;) {
    const page = await search({ ...base, offset });
    pages.push(page);
    rows += page.tools.length;
    if (!page.hasMore) break;
    assert.equal(
      page.nextOffset,
      page.offset + page.tools.length,
      `${JSON.stringify(base)}: nextOffset continues the page`,
    );
    offset = page.nextOffset!;
  }
  return pages;
}

const ranked = (pages: readonly SearchPage[]): RankedRow[] =>
  pages.flatMap((page) => page.tools).map((row) => ({ address: row.address, alsoOn: row.alsoOn ?? [] }));

interface DeploymentIndex {
  search: Search;
  addresses: Set<string>;
  reads: Set<string>;
}

async function index(connectors: Connector[]): Promise<DeploymentIndex> {
  const search = endpoint(connectors);
  const all = ranked(await walk(search, { query: "", limit: 100 })).map((row) => row.address);
  const reads = ranked(await walk(search, { query: "", limit: 100, safety: "readOnly" })).map((row) => row.address);
  return { search, addresses: new Set(all), reads: new Set(reads) };
}

function checkLabels(query: RetrievalQuery, deployment: DeploymentIndex): boolean {
  for (const pattern of query.answers) {
    if (![...deployment.addresses].some((address) => matchesAnswer(pattern, address)))
      throw new Error(
        `"${query.query}" (${query.deployment}): answer ${pattern} matches no tool in the fixture catalog`,
      );
  }
  return query.answers.some((pattern) => [...deployment.reads].some((address) => matchesAnswer(pattern, address)));
}

async function score(
  deployments: Record<Deployment, DeploymentIndex>,
): Promise<{ scored: ScoredQuery[]; pages: Map<string, string[]> }> {
  const scored: ScoredQuery[] = [];
  const pages = new Map<string, string[]>();
  const sets: [QuerySet, readonly RetrievalQuery[]][] = [
    ["main", MAIN_QUERIES],
    ["holdout", HOLDOUT_QUERIES],
  ];
  for (const [set, queries] of sets) {
    for (const query of queries) {
      const deployment = deployments[query.deployment];
      const hasRead = checkLabels(query, deployment);
      const rows = ranked(await walk(deployment.search, { query: query.query, limit: MRR_DEPTH }, MRR_DEPTH));
      const row: ScoredQuery = { set, query, all: firstRank(query.answers, rows) };
      pages.set(
        queryKey(row),
        rows.slice(0, 8).map((entry) => entry.address),
      );
      if (hasRead) {
        const readRows = ranked(
          await walk(deployment.search, { query: query.query, limit: MRR_DEPTH, safety: "readOnly" }, MRR_DEPTH),
        );
        row.readOnly = firstRank(query.answers, readRows);
      }
      scored.push(row);
    }
  }
  return { scored, pages };
}

async function pagingCases(): Promise<string[]> {
  const failures: string[] = [];
  const search = endpoint(pagingDeployment());
  const projectTools = await pagingDeployment()[0]!.listTools({} as never);
  const projectAddresses = projectTools.map((tool) => `projects.${tool.name}`);
  const projectReads = projectTools
    .filter((tool) => tool.annotations?.readOnlyHint)
    .map((tool) => `projects.${tool.name}`);
  const runbookWrites = (await pagingDeployment()[1]!.listTools({} as never))
    .filter((tool) => !tool.annotations?.readOnlyHint)
    .map((tool) => `runbook.${tool.name}`);
  const cases: {
    name: string;
    args: SearchArgs;
    answers: readonly string[];
    exact?: boolean;
    shortFirstPage?: boolean;
  }[] = [
    {
      name: "browse a 300-tool connector at the default limit",
      args: { connector: "projects" },
      answers: projectAddresses,
      exact: true,
    },
    {
      name: "browse a 300-tool connector at the maximum limit",
      args: { connector: "projects", limit: 100 },
      answers: projectAddresses,
      exact: true,
    },
    {
      name: "browse a 300-tool connector's reads",
      args: { connector: "projects", limit: 50, safety: "readOnly" },
      answers: projectReads,
      exact: true,
    },
    {
      name: "a query with more answers than one page",
      args: { query: "todo", limit: 8 },
      answers: projectTools
        .filter((tool) => tool.name.split("_").includes("todo"))
        .map((tool) => `projects.${tool.name}`),
    },
    {
      name: "long write descriptions end a page early",
      args: { query: "maintenance procedure", limit: 20 },
      answers: runbookWrites,
      shortFirstPage: true,
    },
  ];
  for (const entry of cases) {
    const fail = (detail: string) => failures.push(`${entry.name}: ${detail}`);
    try {
      const pages = await walk(search, entry.args);
      const rows = ranked(pages).map((row) => row.address);
      const first = pages[0]!;
      if (entry.answers.length <= first.tools.length)
        fail(`fixture has ${entry.answers.length} answers, not more than the first page's ${first.tools.length}`);
      if (!first.hasMore || first.nextOffset === undefined)
        fail("the first page leaves answers behind without hasMore and nextOffset");
      if (entry.shortFirstPage && first.tools.length >= Math.min(entry.args.limit ?? 8, first.total))
        fail(`the first page has ${first.tools.length} rows; the fixture should end it before the limit`);
      const last = pages.at(-1)!;
      if (last.hasMore || last.nextOffset !== undefined) fail("the last page still claims more");
      if (new Set(rows).size !== rows.length) fail("an address appears on two pages");
      if (pages.some((page) => page.total !== first.total)) fail("total changes between pages");
      if (rows.length !== first.total) fail(`walked ${rows.length} rows, total says ${first.total}`);
      const missing = entry.answers.filter((answer) => !rows.includes(answer));
      if (missing.length) fail(`unreachable by paging: ${missing.slice(0, 5).join(", ")}`);
      if (entry.exact && rows.length !== entry.answers.length)
        fail(`browse returned ${rows.length} rows for ${entry.answers.length} tools`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}

const percent = (value: number) => (value * 100).toFixed(1).padStart(5);
const line = (label: string, m: Metrics, was?: Metrics) =>
  `${label.padEnd(18)} n=${String(m.n).padStart(3)}  R@1 ${percent(m.r1)}  R@5 ${percent(m.r5)}  R@8 ${percent(m.r8)}  MRR ${m.mrr.toFixed(3)}` +
  (was ? `   (baseline R@5 ${percent(was.r5)}, MRR ${was.mrr.toFixed(3)})` : "");

function report(summary: Summary, baseline: Summary | undefined) {
  for (const set of ["main", "holdout"] as const) {
    const now = summary[set];
    const was = baseline?.[set];
    console.log(`${set}:`);
    console.log("  " + line("all", now.all, was?.all));
    console.log("  " + line("readOnly", now.readOnly, was?.readOnly));
    console.log("  " + line("certain labels", now.certain, was?.certain));
    for (const [type, metrics] of Object.entries(now.types))
      console.log("  " + line(`type ${type}`, metrics, was?.types[type as keyof typeof now.types]));
  }
}

function controls(scored: readonly ScoredQuery[], summary: Summary): string[] {
  const shift = (rank: number) => (rank === 0 || rank >= MRR_DEPTH ? 0 : rank + 1);
  const degraded = summarize(
    scored.map((row) => ({
      ...row,
      all: shift(row.all),
      ...(row.readOnly === undefined ? {} : { readOnly: shift(row.readOnly) }),
    })),
  );
  const empty = summarize(
    scored.map((row) => ({ ...row, all: 0, ...(row.readOnly === undefined ? {} : { readOnly: 0 }) })),
  );
  const failures: string[] = [];
  if (!gate(degraded, summary).failures.length)
    failures.push("control: a ranking one place lower everywhere passed the gate");
  if (!gate(empty, summary).failures.length) failures.push("control: a ranking with no answers passed the gate");
  if (gate(summary, summary).failures.length) failures.push("control: the current ranking failed against itself");
  return failures;
}

async function main() {
  const deployments = Object.fromEntries(
    await Promise.all(Object.entries(DEPLOYMENTS).map(async ([name, build]) => [name, await index(build())] as const)),
  ) as Record<Deployment, DeploymentIndex>;
  for (const [name, deployment] of Object.entries(deployments))
    console.log(`${name}: ${deployment.addresses.size} tools, ${deployment.reads.size} reads`);
  const { scored, pages } = await score(deployments);
  const summary = summarize(scored);
  const failures: string[] = [];

  const fresh = Object.fromEntries(
    Object.entries(DEPLOYMENTS).map(([name, build]) => [name, endpoint(build())]),
  ) as Record<Deployment, Search>;
  for (const row of scored.filter((_, position) => position % 8 === 0)) {
    const again = ranked(
      await walk(fresh[row.query.deployment], { query: row.query.query, limit: MRR_DEPTH }, MRR_DEPTH),
    )
      .slice(0, 8)
      .map((entry) => entry.address);
    if (JSON.stringify(again) !== JSON.stringify(pages.get(queryKey(row))))
      failures.push(`nondeterministic ranking for "${row.query.query}"`);
  }

  failures.push(...(await pagingCases()));
  failures.push(...controls(scored, summary));

  const rankText = (row: ScoredQuery) => `${row.all}/${row.readOnly ?? "-"}`;
  const ranks = Object.fromEntries(scored.map((row) => [queryKey(row), rankText(row)]));
  const current: Baseline = { summary, ranks };
  let baseline: Baseline | undefined;
  try {
    baseline = JSON.parse(await readFile(BASELINE, "utf8")) as Baseline;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  report(summary, baseline?.summary);

  if (args.has("update-baseline")) {
    if (failures.length) {
      for (const failure of failures) console.log(`FAIL ${failure}`);
      throw new Error("Refusing to write a baseline while paging, determinism or control checks fail.");
    }
    await writeFile(BASELINE, JSON.stringify(current, null, 2) + "\n");
    console.log(`Wrote ${BASELINE}`);
    return;
  }
  if (!baseline) failures.push(`no baseline at ${BASELINE}; run with --update-baseline`);
  else {
    const verdict = gate(summary, baseline.summary);
    failures.push(...verdict.failures.map((failure) => `regression: ${failure}`));
    for (const improvement of verdict.improvements)
      console.log(`improved: ${improvement} (record it with --update-baseline)`);
    const moved = scored.flatMap((row) => {
      const before = baseline!.ranks[queryKey(row)]?.split("/").map(Number);
      if (!before) return [];
      const worse = (now: number | undefined, was: number | undefined) =>
        now !== undefined && was !== undefined && was > 0 && (now === 0 || now > was);
      return worse(row.all, before[0]) || worse(row.readOnly, before[1])
        ? [`  ${queryKey(row)}: ${baseline!.ranks[queryKey(row)]} -> ${rankText(row)}`]
        : [];
    });
    if (moved.length && (verdict.failures.length || args.has("verbose")))
      console.log(`ranked lower than baseline (all/readOnly, 0 = not in top ${MRR_DEPTH}):\n${moved.join("\n")}`);
  }
  if (args.has("verbose"))
    for (const row of scored.filter((entry) => entry.all === 0 || entry.all > 5))
      console.log(`  miss@5 ${queryKey(row)} rank ${row.all}: ${pages.get(queryKey(row))!.join(", ")}`);

  const out =
    args.get("out") ?? (failures.length ? join(ROOT, "eval", "results", `retrieval-${stamp()}.json`) : undefined);
  if (out) {
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(
      resolve(out),
      JSON.stringify({ failures, ...current, pages: Object.fromEntries(pages) }, null, 2) + "\n",
    );
    console.log(`Wrote ${resolve(out)}`);
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  if (failures.length) process.exitCode = 1;
  else console.log("retrieval: pass");
}

await main();
