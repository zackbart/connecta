/** Frozen surface-neutral Vercel workflows (#703). Grading uses state/HTTP facts. */
import type { AgentTrace } from "../agent/trace.js";
import type { World } from "../fakes/world.js";
import { OLD_ENV, PREVIEW_ENV } from "../fakes/rest.js";
import { VERCEL_DEPLOYMENTS, vercelDeployments } from "../fakes/vercel.js";
import { check } from "./baseline.js";
import type { ActiveTask, Check, ReferenceContext } from "./types.js";

type Args = Record<string, any>;
const service = "vercel_rest";
const calls = (w: World, method: string, path: string) =>
  w.ledger.calls.filter((c) => c.service === service && c.args.method === method && c.args.path === path);
const good = (w: World, path: string) => calls(w, "GET", path).filter((c) => c.outcome === "ok");
const expected: Record<string, Args> = {
  "filtered-deployments": {
    deployments: [
      { id: "dpl_release002", sha: "sha_release_2" },
      { id: "dpl_release007", sha: "sha_release_7" },
    ],
  },
  "team-project-alias": {
    teamId: "team_fake",
    projectId: "prj_web",
    deploymentId: "dpl_release000",
    domain: "app.example.com",
    alias: "web-prod.example.app",
  },
  "deployment-paging": { count: 137, errors: 2 },
  "domain-hatch": { domain: "app.example.com", verified: false, challenge: "verify-abc" },
  "bounded-logs": {
    buildDeploymentId: "dpl_release002",
    buildError: "Build failed: missing widget.ts",
    requestPath: "/api/widget",
    status: 504,
  },
  "env-once": { id: "env_created", key: "FEATURE_FLAG", target: "production" },
  "env-recovery": { id: "env_prod", comment: "rotation complete" },
};
function canonical(v: unknown): string {
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => JSON.parse(canonical(x))));
  if (v && typeof v === "object")
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, JSON.parse(canonical(x))]),
      ),
    );
  return JSON.stringify(v);
}
function grade(suffix: string, w: World, trace: AgentTrace): Check[] {
  const out: Check[] = [],
    add = (id: string, pass: boolean) => out.push(check(id, id, pass));
  const answer = trace.finalAnswer ?? "";
  let parsed: Args = {};
  try {
    parsed = JSON.parse(answer.match(/ANSWER:\s*(\{[^\n]*\})/)?.[1] ?? "{}");
  } catch {
    /* invalid answer fails */
  }
  add("answer-evidence", canonical(parsed) === canonical({ source: "Vercel", ...expected[suffix] }));
  const writes = w.ledger.calls.filter((c) => c.kind === "write");
  if (suffix === "filtered-deployments")
    add(
      "correct-destination",
      good(w, "/v7/deployments").some((c) => {
        const rows = vercelDeployments(c.args.query as Args).deployments;
        return ["dpl_release002", "dpl_release007"].every((id) => rows.some((d) => d.uid === id));
      }),
    );
  else if (suffix === "team-project-alias")
    add(
      "correct-destination",
      ["/v2/teams", "/v10/projects", "/v2/deployments/dpl_release000/aliases", "/v9/projects/prj_web/domains"].every(
        (p) => good(w, p).length > 0,
      ),
    );
  else if (suffix === "deployment-paging") {
    const pages = good(w, "/v7/deployments"),
      ids = new Set(pages.flatMap((c) => vercelDeployments(c.args.query as Args).deployments.map((d) => d.uid)));
    add(
      "correct-destination",
      pages.length > 1 &&
        VERCEL_DEPLOYMENTS.every((d) => ids.has(d.uid)) &&
        pages.some((c) => vercelDeployments(c.args.query as Args).pagination.next === null),
    );
  } else if (suffix === "domain-hatch")
    add("correct-destination", good(w, "/v9/projects/prj_web/domains/app.example.com").length > 0);
  else if (suffix === "bounded-logs")
    add(
      "correct-destination",
      good(w, "/v3/deployments/dpl_release002/events").length > 0 &&
        good(w, "/v1/projects/prj_web/deployments/dpl_release000/runtime-logs").length > 0,
    );
  else {
    const create = suffix === "env-once",
      path = create ? "/v10/projects/prj_web/env" : "/v9/projects/prj_web/env/env_prod";
    const sent = calls(w, create ? "POST" : "PATCH", path);
    add("correct-destination", good(w, "/v10/projects/prj_web/env").length > 0 && sent.length > 0);
    add("once", sent.length === 1 && writes.length === 1);
    add(
      "state",
      create
        ? w.rest.envs.some(
            (e) =>
              e.id === "env_created" &&
              e.key === "FEATURE_FLAG" &&
              e.value === "enabled" &&
              e.type === "plain" &&
              canonical(e.target) === '["production"]',
          )
        : w.rest.envs[0]?.comment === "rotation complete" && w.rest.envs[0]?.value === "z9Q4p7R2s6T8v1X3",
    );
    if (!create)
      add(
        "reconciled",
        sent[0]?.error === "HTTP 500" && good(w, "/v10/projects/prj_web/env").some((c) => c.seq > sent[0]!.seq),
      );
  }
  add("secret-safe", ![OLD_ENV, PREVIEW_ENV, "z9Q4p7R2s6T8v1X3"].some((s) => answer.includes(s)));
  if (!suffix.startsWith("env-"))
    add(
      "reads-only",
      writes.length === 0 &&
        !trace.toolUses.some((u) => u.tool === "call_destructive_tool") &&
        !w.programs.some((p) =>
          p.calls.some(
            (c) => c.name === "connecta.call" && /(?:_write|upsert_|update_|delete_)/.test(String(c.args[0])),
          ),
        ),
    );
  return out;
}
const read = (ctx: ReferenceContext, tool: string, args: Args = {}) =>
  ctx.call("call_tool", { address: `${service}.${tool}`, args, resultMode: "value" });
async function reference(suffix: string, ctx: ReferenceContext) {
  if (suffix === "filtered-deployments")
    await read(ctx, "vercel_api_read", {
      path: "/v7/deployments",
      query: { projectId: "prj_web", target: "production", state: "ERROR", limit: 100 },
    });
  else if (suffix === "team-project-alias") {
    await read(ctx, "list_teams");
    await read(ctx, "vercel_api_read", { path: "/v10/projects", query: { teamId: "team_fake" } });
    await read(ctx, "vercel_api_read", { path: "/v2/deployments/dpl_release000/aliases" });
    await read(ctx, "vercel_api_read", { path: "/v9/projects/prj_web/domains" });
  } else if (suffix === "deployment-paging") {
    let next: unknown;
    do {
      // Keep continuation visible on both surfaces: reduce the full page in
      // the guest before the execution output budget can cut its trailing page.
      const query = { projectId: "prj_web", target: "production", limit: 100, ...(next ? { until: next } : {}) };
      const r = await ctx.call("execute_code", {
        code: `async () => { const r=await connecta.call("vercel_rest.vercel_api_read", ${JSON.stringify({ path: "/v7/deployments", query })}); return {page:r.data.page}; }`,
      });
      if (r.isError) throw Error(r.text);
      next =
        /"nextCursor"\s*:\s*"([^"]+)"/.exec(r.text)?.[1] ??
        /"next"\s*:\s*"([^"]+)"/.exec(r.text)?.[1] ??
        /"next"\s*:\s*(\d+)/.exec(r.text)?.[1];
    } while (next);
  } else if (suffix === "domain-hatch") {
    await read(ctx, "vercel_api_search", { query: "get project domain", method: "GET" });
    await read(ctx, "vercel_api_read", { path: "/v9/projects/prj_web/domains/app.example.com" });
  } else if (suffix === "bounded-logs") {
    await read(ctx, "get_deployment_build_logs", { deploymentId: "dpl_release002" });
    await read(ctx, "get_runtime_logs", {
      projectId: "prj_web",
      deploymentId: "dpl_release000",
      waitMs: 1000,
      levels: ["error"],
    });
  } else {
    await read(ctx, "list_project_env_vars", { projectId: "prj_web" });
    const create = suffix === "env-once";
    const r = await ctx.call("call_destructive_tool", {
      address: `${service}.${create ? "upsert_project_env_var" : "update_project_env_var"}`,
      args: create
        ? {
            projectId: "prj_web",
            key: "FEATURE_FLAG",
            value: "enabled",
            type: "plain",
            targets: ["production"],
            upsert: false,
          }
        : { projectId: "prj_web", envVarId: "env_prod", value: "z9Q4p7R2s6T8v1X3", comment: "rotation complete" },
    });
    if (!create) {
      if (!r.isError) throw Error("Expected committed-write failure");
      await read(ctx, "list_project_env_vars", { projectId: "prj_web" });
    }
  }
  ctx.answer(`ANSWER: ${JSON.stringify({ source: "Vercel", ...expected[suffix] })}`);
}
const scenarios = [
  [
    "filtered-deployments",
    "Filtered production failures",
    "For project web, list every failed production deployment with its commit SHA. Exclude preview and other projects.",
    '"deployments":[{"id":"<id>","sha":"<sha>"}]',
  ],
  [
    "team-project-alias",
    "Team, project and domain join",
    "Resolve team studio and its web project, then report its newest production deployment, its deployment alias and its custom project domain.",
    '"teamId":"<id>","projectId":"<id>","deploymentId":"<id>","domain":"<domain>","alias":"<alias>"',
  ],
  [
    "deployment-paging",
    "All deployment pages",
    "Count all production deployments of project web, and how many have ERROR state. Traverse every page.",
    '"count":<integer>,"errors":<integer>',
  ],
  [
    "domain-hatch",
    "Rare domain verification",
    "For project prj_web, inspect app.example.com. Report whether it is verified and the exact pending TXT challenge value. Do not mutate anything.",
    '"domain":"<domain>","verified":<boolean>,"challenge":"<value>"',
  ],
  [
    "bounded-logs",
    "Build and runtime diagnostics",
    "Read bounded build logs of dpl_release002, and error-level runtime logs of prj_web/dpl_release000. Report the build error and runtime failed request path and HTTP status. Do not follow an unbounded stream.",
    '"buildDeploymentId":"<id>","buildError":"<text>","requestPath":"<path>","status":<integer>',
  ],
  [
    "env-once",
    "Create one environment variable",
    "In prj_web, inspect environment metadata, then create FEATURE_FLAG with value enabled, type plain and target production exactly once, without overwriting an existing variable. Never reveal existing values. Confirm its id, key and target.",
    '"id":"<id>","key":"<key>","target":"<target>"',
  ],
  [
    "env-recovery",
    "Reconcile uncertain env update",
    "In prj_web, resolve production STRIPE_KEY by metadata. Update its value to z9Q4p7R2s6T8v1X3 and its comment to rotation complete. If the outcome is uncertain, reconcile the id/comment through metadata without resending the write. Do not repeat any secret value in your answer. Confirm its id and comment.",
    '"id":"<id>","comment":"<comment>"',
  ],
] as const;
export const VERCEL_TASKS: ActiveTask[] = scenarios.map(([suffix, title, prompt, shape]) => ({
  status: "active",
  id: `vercel-step2-${suffix}`,
  title,
  introducedIn: "#703",
  measures: title,
  world: { restVendor: "vercel", vercelStep2: true, refundFault: suffix === "env-recovery" },
  ...(!suffix.startsWith("env-") ? { deployment: { readOnly: true } } : {}),
  prompt: `Using vercel_rest (Vercel), ${prompt} Finish with exactly one single-line JSON object after ANSWER: in the shape {"source":"Vercel",${shape}}. Substitute observed facts.`,
  grade: ({ world, trace }) => grade(suffix, world, trace),
  reference: (ctx) => reference(suffix, ctx),
}));
