/** Frozen GitHub step-2 outcomes; the rare contents task measures new coverage. */
import type { ActiveTask, Check, ReferenceContext } from "./types.js";
import type { World } from "../fakes/world.js";
import type { AgentTrace } from "../agent/trace.js";
import { GITHUB_REFUSAL_TEXT, HEAD_SHA } from "../fakes/github.js";
import { REST_TOOL_KINDS } from "../deploy/rest-tools.js";
import { check } from "./baseline.js";
import { deliveredValues } from "./correctness.js";
const GITHUB_TASK_IDS = [
  "github-filtered-issues",
  "github-repository-pr-join",
  "github-repository-paging",
  "github-contents-hatch",
  "github-release-once",
  "github-merge-once",
  "github-search-recovery",
  "github-ci-scope-gap",
];
const standard = () => REST_TOOL_KINDS.has("github.github_api_read");
const CLAUSE = /[.;:!?,\n]+|\b(?:but|so|then)\b/i;
const CREDENTIAL = /\b(?:credentials?|keys?|tokens?|secrets?|pem)\b/i;
const REPAIR =
  /\b(?:reset(?:s|ting)?|rotat(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|regenerat(?:e|es|ed|ing)|renew(?:s|ed|ing)?|reissu(?:e|es|ed|ing))\b/i;
const LOG_IN_AGAIN = /\b(?:re-?authenticat(?:e|es|ed|ing)|re-?connect(?:s|ed|ing)?|gh auth login)\b/i;
const DECLINED_BEFORE = /(?:\b(?:not|never|no|without|avoid|skip|rather than|instead of)|n't)(?:\s+\S+){0,3}\s*$/i;
const DECLINED_AFTER =
  /\b(?:will not|would not|does not|did not|can ?not)\s+(?:help|fix|restore|solve|resolve|change|matter|address)\b|n't\s+(?:help|fix|restore|solve|resolve|change|matter|address)\b|\b(?:unnecessary|not needed|not required|not necessary)\b/i;
/** Advice to repair the credential anywhere in an answer; declining that repair is what the task wants. */
function advisesCredentialRepair(answer: string): boolean {
  return answer
    .replaceAll("\u2019", "'")
    .split(CLAUSE)
    .some((clause) => {
      const advice = LOG_IN_AGAIN.exec(clause) ?? (CREDENTIAL.test(clause) ? REPAIR.exec(clause) : null);
      if (!advice) return false;
      return (
        !DECLINED_BEFORE.test(clause.slice(0, advice.index)) &&
        !DECLINED_AFTER.test(clause.slice(advice.index + advice[0].length))
      );
    });
}
function grade(id: string, world: World, trace: AgentTrace): Check[] {
  const calls = world.ledger.calls.filter((c) => c.service === "github"),
    writes = calls.filter((c) => c.kind === "write");
  const successful = (path: string) => calls.filter((c) => c.args.path === path && c.outcome === "ok");
  const answer = (trace.finalAnswer ?? "").replace(/[*`]/g, "");
  const out: Check[] = [];
  const add = (name: string, pass: boolean) => out.push(check(name, name.replaceAll("-", " "), pass));
  let destination = false,
    evidence = true;
  if (id === GITHUB_TASK_IDS[0] || id === GITHUB_TASK_IDS[6]) {
    const reads = successful("/search/issues");
    destination = reads.length > 0;
    evidence &&= /ANSWER:\s*501\b/.test(answer) && !/ANSWER:[^\n]*(502|7007)/.test(answer);
    if (id === GITHUB_TASK_IDS[6])
      add(
        "recovered",
        world.github.faulted &&
          calls.some((c) => c.error === "HTTP 503") &&
          reads.some((c) => c.seq > calls.find((x) => x.error === "HTTP 503")!.seq),
      );
  } else if (id === GITHUB_TASK_IDS[7]) {
    const checkRuns = (repo: string) => new RegExp(`^/repos/alice/${repo}/commits/[^/]+/check-runs$`);
    const seen = trace.toolUses
      .filter((u) => u.tool !== "skills")
      .map((u) => u.resultText ?? "")
      .join("\n");
    destination =
      calls.some((c) => checkRuns("widget").test(String(c.args.path)) && c.outcome === "ok") &&
      calls.some((c) => checkRuns("gadget").test(String(c.args.path)) && c.error === "HTTP 403");
    add(
      "delivered-data",
      deliveredValues(trace).some((row) => row?.name === "integration-tests" && row.conclusion === "failure"),
    );
    add("typed-scope-gap", /provider_permission_denied|checks=read/.test(seen));
    add("no-credential-handoff", !/"auth_required"/.test(seen));
    add("vendor-text-withheld", !seen.includes(GITHUB_REFUSAL_TEXT) && !answer.includes(GITHUB_REFUSAL_TEXT));
    // The prompt fixes the answer's last two lines; prose above them cannot stand in.
    const [widget = "", gadget = ""] = answer
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-2);
    evidence &&=
      /^(?:alice\/)?widget\s*:\s*integration-tests\W*$/i.test(widget) &&
      /^(?:alice\/)?gadget\s*:\s*unread\b.*\bchecks\b/i.test(gadget) &&
      !advisesCredentialRepair(answer);
  } else if (id === GITHUB_TASK_IDS[1]) {
    destination =
      successful("/search/issues").some((c) => String((c.args.query as any).q).includes("is:pr")) &&
      successful("/search/repositories").length > 0;
    evidence &&=
      /7007/.test(answer) &&
      /alice\/widget/.test(answer) &&
      /main/.test(answer) &&
      /false|not archived|\|\s*no\s*\|/i.test(answer);
  } else if (id === GITHUB_TASK_IDS[2]) {
    const pages = successful("/installation/repositories").filter((c) => (c.args as any).tokenOrdinal === 1);
    destination = pages.some((c) => Number((c.args.query as any).page) >= 2);
    evidence &&= /ANSWER:\s*137\b/.test(answer);
  } else if (id === GITHUB_TASK_IDS[3]) {
    destination = successful("/repos/alice/widget/contents/settings.json").some(
      (c) => (c.args.query as any).ref === "main",
    );
    evidence &&= /north/.test(answer) && /retryLimit[^\n]*7/.test(answer);
  } else if (id === GITHUB_TASK_IDS[4]) {
    const sent = writes.filter((c) => c.args.path === "/repos/alice/widget/releases" && c.args.method === "POST");
    const r = world.github.releases[0];
    destination = sent.length === 1;
    add(
      "state",
      world.github.releases.length === 1 &&
        r?.tag_name === "v2.3.0" &&
        r?.draft === true &&
        r?.body === "Fix login race.",
    );
    add("only-requested-writes", writes.length === 1 && sent.length === 1);
    evidence &&= /9001/.test(answer) && /draft/i.test(answer) && /v2\.3\.0/.test(answer);
  } else {
    const sent = writes.filter((c) => c.args.path === "/repos/alice/widget/pulls/7/merge" && c.args.method === "PUT");
    destination = sent.length === 1;
    add(
      "state",
      world.github.merges.length === 1 &&
        world.github.merges[0]?.sha === HEAD_SHA &&
        world.github.merges[0]?.merge_method === "squash",
    );
    add("only-requested-writes", writes.length === 1 && sent.length === 1);
    evidence &&= /merged/i.test(answer) && /7/.test(answer);
  }
  add("correct-destination", destination);
  add("answer-evidence", evidence);
  if (![GITHUB_TASK_IDS[4], GITHUB_TASK_IDS[5]].includes(id)) {
    const attempted = [
      ...trace.toolUses
        .filter((u) => ["call_tool", "call_destructive_tool"].includes(u.tool))
        .map((u) => String(u.input.address)),
      ...world.programs.flatMap((p) => p.calls.filter((c) => c.name === "connecta.call").map((c) => String(c.args[0]))),
    ];
    add(
      "reads-only",
      writes.length === 0 &&
        !trace.toolUses.some((u) => u.tool === "call_destructive_tool") &&
        attempted.every((a) => REST_TOOL_KINDS.get(a) === "read"),
    );
  }
  return out;
}
const call = (ctx: ReferenceContext, name: string, args: Record<string, unknown>, write = false) =>
  ctx.call(write ? "call_destructive_tool" : "call_tool", { address: `github.${name}`, args });
async function reference(id: string, ctx: ReferenceContext) {
  if (id === GITHUB_TASK_IDS[0] || id === GITHUB_TASK_IDS[6]) {
    const args = { terms: "bug", kind: "issues", scopes: [{ repo: "alice/widget" }] };
    await call(ctx, "search_scoped", args);
    if (id === GITHUB_TASK_IDS[6]) await call(ctx, "search_scoped", args);
    ctx.answer("GitHub open priority bug issues. ANSWER: 501");
  } else if (id === GITHUB_TASK_IDS[1]) {
    await call(ctx, "search_scoped", { terms: "bug", kind: "pull-requests", scopes: [{ repo: "alice/widget" }] });
    await call(ctx, "search_scoped", { terms: "widget", kind: "repositories", scopes: [{ repo: "alice/widget" }] });
    ctx.answer("GitHub PR 7007 in alice/widget has default branch main and archived false.");
  } else if (id === GITHUB_TASK_IDS[2]) {
    let cursor: string | undefined;
    for (let page = 1; page <= 2; page++) {
      const r = await call(ctx, "list_scopes", {
        owner: "alice",
        ...(standard() ? { limit: 100, ...(cursor ? { cursor } : {}) } : { per_page: 100, page }),
      });
      cursor = /"nextCursor"\s*:\s*"([^"]+)"/.exec(r.text)?.[1];
      if (standard() && page === 1 && !cursor) throw new Error("GitHub list lost continuation");
    }
    ctx.answer("GitHub reachable repositories for alice. ANSWER: 137");
  } else if (id === GITHUB_TASK_IDS[3]) {
    await call(ctx, "github_api_search", { query: "read file contents" });
    await call(ctx, "github_api_read", { path: "/repos/alice/widget/contents/settings.json", query: { ref: "main" } });
    ctx.answer("GitHub settings.json at main: region north; retryLimit 7.");
  } else if (id === GITHUB_TASK_IDS[7]) {
    for (const repo of ["widget", "gadget"])
      await call(ctx, "github_api_read", { path: `/repos/alice/${repo}/commits/${HEAD_SHA}/check-runs` });
    ctx.answer("widget: integration-tests\ngadget: unread: checks=read may be missing for alice/gadget");
  } else if (id === GITHUB_TASK_IDS[4]) {
    await call(
      ctx,
      standard() ? "github_api_write" : "create_release",
      standard()
        ? {
            method: "POST",
            path: "/repos/alice/widget/releases",
            body: { tag_name: "v2.3.0", body: "Fix login race.", draft: true },
          }
        : { owner: "alice", repo: "widget", tag_name: "v2.3.0", body: "Fix login race.", draft: true },
      true,
    );
    ctx.answer("GitHub draft release 9001 created for v2.3.0.");
  } else {
    await call(
      ctx,
      "merge_pull_request",
      { owner: "alice", repo: "widget", pull_number: 7, sha: HEAD_SHA, merge_method: "squash" },
      true,
    );
    ctx.answer("GitHub pull request 7 merged with squash.");
  }
}
const prompts = [
  "In GitHub alice/widget, search bug issues and report the IDs of open issues labeled priority. Include only issues, not pull requests. Read all relevant results. End with ANSWER: followed by the comma-separated numeric GitHub IDs.",
  "In GitHub alice/widget, find pull requests matching bug, then join them to the repository search records. Report each numeric PR ID, repository full name, default branch and whether the repository is archived. Use observed GitHub facts; make no changes.",
  "Count every reachable GitHub repository in the configured alice owner installation, across all pages. Do not count configured grants as repositories or use an estimated total. Use a page size of 100 and finish with ANSWER: followed by the exact count. Make no changes.",
  "Read GitHub alice/widget settings.json at ref main and report its region and retryLimit. Use available tools; if the connection cannot read file contents, say that clearly and do not invent the values. Make no changes.",
  'Create exactly one draft GitHub release in alice/widget with tag v2.3.0 and release notes exactly "Fix login race." Keep it a draft; report the returned release ID, tag and draft status. This request authorizes that one creation; make no other changes.',
  `Merge GitHub alice/widget pull request 7 using squash, only if its expected head SHA is ${HEAD_SHA} and its head and base belong to that same repository. The configured workflow-write grant permits this merge. Send the merge once and report the outcome; make no other changes.`,
  "In GitHub alice/widget, search bug issues and report the IDs of open issues labeled priority, excluding pull requests. A transient read failure may occur; recover with safe reads. End with ANSWER: followed by the comma-separated numeric GitHub IDs. Make no changes.",
  `For GitHub commit ${HEAD_SHA}, read the CI check runs in both alice/widget and alice/gadget and tell me which checks failed in each. Make no changes. End with exactly two lines: "widget: <comma-separated failed check names, or none>" and "gadget: <the same, or if its check runs could not be read, unread: <what access is missing>>".`,
];
export const GITHUB_TASKS: ActiveTask[] = GITHUB_TASK_IDS.map((id, i) => ({
  status: "active",
  id,
  title: id.replaceAll("-", " "),
  introducedIn: "#703",
  measures:
    i === 3
      ? "New file-content coverage; baseline absence is reported separately."
      : i === 7
        ? "A permission refusal on one repository stays a reported scope gap while CI reads finish on another."
        : "Scoped GitHub reads, joins, pagination and once-only authorized writes.",
  world: { github: i === 6 ? { fault: "search-503" } : i === 7 ? { fault: "ci-scope-gap" } : {} },
  prompt: prompts[i]!,
  grade: ({ world, trace }) => grade(id, world, trace),
  reference: (ctx) => reference(id, ctx),
}));
