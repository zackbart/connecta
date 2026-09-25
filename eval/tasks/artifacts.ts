/**
 * P2: artifacts (#562). Team pages through the built-in `artifacts`
 * connector: publishing one whose numbers live in documents rather than the
 * HTML, and editing one with an exact patch rather than a rewrite.
 *
 * Artifact state lives in the deployment's store; the runner snapshots it
 * into `world.artifacts` before grading.
 */
import { validateArtifact } from "@zackbart/connecta/artifacts";
import { hasExactOpenBugRows } from "./artifact-grader.js";
import type { ArtifactSnapshot, World } from "../fakes/world.js";
import { check, quote, singlePost } from "./baseline.js";
import type { ActiveTask, Check } from "./types.js";
import { uses } from "./types.js";

type Snapshot = ArtifactSnapshot["artifacts"][number];

/** Open bugs per project, and the MRR of every customer an open bug names. */
function expectedFigures(world: World) {
  const accounts: Record<string, number> = {
    "initech.com": 48_000,
    "globex.com": 31_500,
    "soylent.com": 22_000,
    "stark.com": 56_500,
    "wayne.com": 51_000,
    "acme.com": 9_000,
  };
  const open = world.tracker.issues.filter(
    (issue) => issue.status === "open" && issue.labels.includes("bug"),
  );
  const counts = {
    web: open.filter((issue) => issue.project === "web").length,
    api: open.filter((issue) => issue.project === "api").length,
    mobile: open.filter((issue) => issue.project === "mobile").length,
  };
  const mrr = [
    ...new Set(open.map((issue) => issue.customer).filter((domain): domain is string => Boolean(domain))),
  ].map((domain) => ({ domain, mrr: accounts[domain] ?? Number.NaN }));
  return { counts, mrr };
}

const PROJECT_NAMES: Record<string, RegExp> = {
  web: /^(web|WEB)$/i,
  api: /^(api)$/i,
  mobile: /^(mobile|mob)$/i,
};

/**
 * Whether the documents state `count` for `project`: a field named for the
 * project holding the number (or an object holding it, or a list of that
 * length), an object that names the project in a value and carries the
 * number, or rows naming the project whose bug counts add up to it — the
 * figure is in the data either way, which is what the task measures.
 */
function statesCount(documents: unknown, project: string, count: number): boolean {
  return statesCountDirectly(documents, project, count) || rowsSumTo(documents, project, count);
}


function rowsSumTo(documents: unknown, project: string, count: number): boolean {
  const name = PROJECT_NAMES[project] ?? new RegExp(`^${project}$`, "i");
  const totals = new Map<unknown[], number>();
  const visit = (value: unknown, parent?: unknown[]): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, value);
      return;
    }
    const record = value as Record<string, unknown>;
    const names = Object.values(record).some(
      (inner) => typeof inner === "string" && name.test(inner.trim()),
    );
    const counted = Object.entries(record).find(
      ([key, inner]) => typeof inner === "number" && /bug|count|open|issue/i.test(key),
    );
    if (parent && names && counted) {
      totals.set(parent, (totals.get(parent) ?? 0) + (counted[1] as number));
    }
    for (const inner of Object.values(record)) visit(inner);
  };
  visit(documents);
  return [...totals.values()].some((total) => total === count);
}

function statesCountDirectly(documents: unknown, project: string, count: number): boolean {
  const name = PROJECT_NAMES[project] ?? new RegExp(`^${project}$`, "i");
  const holds = (value: unknown): boolean =>
    value === count ||
    (Array.isArray(value) && value.length === count) ||
    (value !== null &&
      typeof value === "object" &&
      Object.values(value as Record<string, unknown>).some(
        (inner) => inner === count || (Array.isArray(inner) && inner.length === count),
      ));
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(visit);
    const record = value as Record<string, unknown>;
    for (const [key, inner] of Object.entries(record)) {
      if (name.test(key) && holds(inner)) return true;
    }
    const namesProject = Object.values(record).some(
      (inner) => typeof inner === "string" && name.test(inner.trim()),
    );
    if (namesProject && Object.values(record).some(holds)) return true;
    return Object.values(record).some(visit);
  };
  return visit(documents);
}

/** Every number anywhere in a JSON value. */
function numbersIn(value: unknown, into: Set<number> = new Set()): Set<number> {
  if (typeof value === "number") into.add(value);
  else if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value as Record<string, unknown>)) numbersIn(inner, into);
  }
  return into;
}

function onlyArtifact(world: World): { artifact?: Snapshot; checks: Check[] } {
  const all = world.artifacts?.artifacts ?? [];
  return {
    ...(all.length === 1 ? { artifact: all[0] } : {}),
    checks: [
      check(
        "one-artifact",
        "exactly one artifact exists",
        all.length === 1,
        `${all.length} artifact(s)${all.length ? `: ${all.map((item) => item.id).join(", ")}` : ""}`,
      ),
    ],
  };
}

const PAGE_PROGRAM = `async () => {
  const bugs = [];
  let cursor;
  do {
    const page = await connecta.call("tracker.search_issues", Object.assign({ status: "open", label: "bug", limit: 50 }, cursor ? { cursor } : {}));
    bugs.push(...page.issues);
    cursor = page.nextCursor;
  } while (cursor);
  const accounts = [];
  let next;
  do {
    const page = await connecta.call("analytics.list_accounts", Object.assign({ limit: 25 }, next ? { cursor: next } : {}));
    accounts.push(...page.accounts);
    next = page.nextCursor;
  } while (next);
  const domains = [...new Set(bugs.map((bug) => bug.customer).filter(Boolean))];
  const customers = [];
  for (const domain of domains) {
    const account = accounts.find((candidate) => candidate.domain === domain);
    const metrics = await connecta.call("analytics.get_account_metrics", { accountId: account.id });
    customers.push({ domain, name: account.name, mrrUsd: metrics.mrrUsd });
  }
  const projects = ["web", "api", "mobile"].map((project) => ({
    project,
    openBugs: bugs.filter((bug) => bug.project === project).length,
    customers: customers.filter((customer) => bugs.some((bug) => bug.project === project && bug.customer === customer.domain)),
  }));
  const source = [
    "<!doctype html>",
    "<html lang=\\"en\\"><head><meta charset=\\"utf-8\\"><title>Open bugs by project</title></head>",
    "<body><main id=\\"artifact-root\\"><h1>Open bugs by project</h1><div id=\\"rows\\"></div></main>",
    "<script>",
    "const rows = window.artifact.data.bugs.projects.map((p) => '<h2>' + p.project + ': ' + p.openBugs + '</h2><ul>' +",
    "  p.customers.map((c) => '<li>' + c.name + ' — $' + c.mrrUsd.toLocaleString() + ' MRR</li>').join('') + '</ul>');",
    "document.getElementById('rows').innerHTML = rows.join('');",
    "</script></body></html>",
  ].join("\\n");
  const made = await connecta.call("artifacts.create_artifact", {
    id: "open-bugs", title: "Open bugs by project", kind: "html", source, documents: { bugs: { projects } }
  });
  return made.url;
}`;

const buildPage: ActiveTask = {
  status: "active",
  id: "p2-build-page",
  title: "Build a page from this data",
  introducedIn: "P2",
  measures: "Publishing an artifact whose data lands in stored documents rather than inline in the HTML.",
  deployment: { artifacts: {} },
  // Names its sources the way cross-connector-join does: which service holds
  // MRR is not what this task measures, and billing looks like the answer.
  prompt:
    "Using the issue tracker and product analytics, build an HTML page showing open bugs per project with each " +
    "affected customer's MRR. Keep the figures in a named JSON document that the page reads, then share the link in #triage.",
  grade: ({ world }) => {
    const { artifact, checks } = onlyArtifact(world);
    const post = singlePost(world, "triage");
    const figures = expectedFigures(world);
    const numbers = numbersIn(artifact?.documents ?? {});
    const missingMrr = figures.mrr.filter(({ mrr }) => !numbers.has(mrr));
    const rawRows = hasExactOpenBugRows(artifact?.documents ?? {}, world.tracker.issues
      .filter(issue => issue.status === "open" && issue.labels.includes("bug"))
      .map(issue => ({ id: issue.id, project: issue.project })));
    const missingCounts = rawRows ? [] : Object.entries(figures.counts).filter(
      ([project, count]) => !statesCount(artifact?.documents ?? {}, project, count),
    );
    const validation = artifact
      ? validateArtifact({
          kind: artifact.kind as "html" | "markdown",
          source: artifact.source,
          documents: artifact.documents,
        })
      : undefined;
    const literalMrr = figures.mrr.filter(({ mrr }) =>
      artifact?.source.includes(String(mrr)) ||
      artifact?.source.includes(mrr.toLocaleString("en-US")));
    return [
      ...checks,
      check(
        "page-validates",
        "the saved page passes validation against its documents",
        validation?.ok === true,
        validation && !validation.ok
          ? validation.errors.map((issue) => issue.message).join(" | ").slice(0, 400)
          : undefined,
      ),
      check(
        "page-reads-documents",
        "the HTML reads its stored data document",
        artifact?.kind === "html" && /\b(?:window\.)?artifact\.data\b/.test(artifact.source),
      ),
      check(
        "data-in-documents",
        "the documents hold each project's open-bug count and every affected customer's MRR",
        artifact !== undefined && missingMrr.length === 0 && missingCounts.length === 0,
        artifact
          ? [
              missingCounts.length ? `counts missing: ${missingCounts.map(([project, count]) => `${project}=${count}`).join(", ")}` : "",
              missingMrr.length ? `MRR missing: ${missingMrr.map(({ domain, mrr }) => `${domain}=${mrr}`).join(", ")}` : "",
              `documents: ${quote(JSON.stringify(artifact.documents))}`,
            ].filter(Boolean).join("; ")
          : "no artifact",
      ),
      check(
        "mrr-not-hardcoded",
        "no MRR figure is written into the HTML itself",
        literalMrr.length === 0,
        literalMrr.length ? literalMrr.map(({ domain }) => domain).join(", ") : undefined,
        true,
      ),
      ...post.checks,
      check(
        "link-shared",
        "the #triage post carries the artifact's URL",
        artifact !== undefined && post.text.includes(`/artifacts/${artifact.id}`),
        quote(post.text),
      ),
    ];
  },
  reference: async ({ call }) => {
    const made = await call("execute_code", { code: PAGE_PROGRAM });
    const url = (JSON.parse(made.text) as { result: string }).result;
    await call("call_destructive_tool", {
      address: "chat.post_message",
      args: { channel: "triage", text: `Open bugs by project, with affected customers' MRR: ${url}` },
      reason: "Share the page as asked",
    });
  },
};

const CHART_PAGE = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>Open bugs</title>',
  "<style>.bar{background:#2f5fe0;color:#fff;margin:4px 0;padding:2px 6px}</style></head>",
  '<body><main id="artifact-root">',
  "<h1>Open bugs</h1>",
  '<section class="chart"><h2 class="chart-title">Bugs by team</h2><div id="bars"></div></section>',
  "<p>Counts come from the tracker.</p>",
  "</main>",
  "<script>",
  "const data = window.artifact.data.data;",
  "document.getElementById('bars').innerHTML = data.projects",
  "  .map((p) => '<div class=\"bar\" style=\"width:' + p.openBugs * 40 + 'px\">' + p.project + ' ' + p.openBugs + '</div>')",
  "  .join('');",
  "</script></body></html>",
].join("\n");

const CHART_DATA = {
  data: { projects: [{ project: "web", openBugs: 7 }, { project: "api", openBugs: 3 }, { project: "mobile", openBugs: 2 }] },
};

const fixChartTitle: ActiveTask = {
  status: "active",
  id: "p2-fix-chart-title",
  title: "Fix the chart title",
  introducedIn: "P2",
  measures: "Editing an artifact with a patch rather than rewriting it.",
  deployment: {
    artifacts: {
      seed: [{ id: "open-bugs", title: "Open bugs", kind: "html", source: CHART_PAGE, documents: CHART_DATA }],
    },
  },
  prompt:
    "The chart title on the open-bugs page says 'Bugs by team'; it should say 'Open bugs by project'. Fix it.",
  grade: ({ world, trace }) => {
    const artifact = world.artifacts?.artifacts.find((item) => item.id === "open-bugs");
    const added = (artifact?.views ?? []).filter((view) => view.version > 1);
    const original = artifact?.views.find((view) => view.version === 1)?.source ?? CHART_PAGE;
    const expected = original.replace("Bugs by team", "Open bugs by project");
    const rewrites = [
      ...uses(trace, "call_destructive_tool"),
      ...uses(trace, "call_tool"),
    ].filter((use) => use.input.address === "artifacts.update_artifact");
    const programRewrites = uses(trace, "execute_code").filter((use) =>
      String(use.input.code ?? "").includes("artifacts.update_artifact"));
    return [
      check(
        "one-new-version",
        "exactly one new view version",
        added.length === 1,
        `${added.length} new version(s)`,
      ),
      check(
        "by-patch",
        "the new version was made by patch_artifact",
        added.length === 1 && added[0]?.op === "patch",
        added.map((view) => view.op).join(", ") || "none",
      ),
      check(
        "only-the-title",
        "the new source differs from the old only in the title",
        artifact?.source === expected,
        artifact ? quote(artifact.source.slice(Math.max(0, artifact.source.indexOf("chart-title") - 20), artifact.source.indexOf("chart-title") + 80)) : "no artifact",
      ),
      check(
        "no-rewrite",
        "update_artifact was never called",
        rewrites.length === 0 && programRewrites.length === 0,
        rewrites.length + programRewrites.length ? `${rewrites.length + programRewrites.length} call(s)` : undefined,
      ),
      check(
        "data-untouched",
        "the page's data was not rewritten",
        (artifact?.documentHistory.data?.length ?? 0) === 1,
        `${artifact?.documentHistory.data?.length ?? 0} data version(s)`,
      ),
    ];
  },
  reference: async ({ call }) => {
    const read = await call("call_tool", {
      address: "artifacts.get_artifact",
      args: { id: "open-bugs", includeSource: false },
    });
    const version = (JSON.parse(read.text) as { view: { version: number } }).view.version;
    await call("call_destructive_tool", {
      address: "artifacts.patch_artifact",
      args: {
        id: "open-bugs",
        baseVersion: version,
        edits: [{ find: "Bugs by team", replace: "Open bugs by project" }],
      },
      reason: "Fix the chart title",
    });
  },
};

export const ARTIFACT_TASKS: ActiveTask[] = [buildPage, fixChartTitle];
