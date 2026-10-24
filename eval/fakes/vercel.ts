/** Isolated Vercel step-2 universe; historical #801 fixtures are unchanged. */
import type { RestState } from "./rest.js";

export const VERCEL_DEPLOYMENTS = Array.from({ length: 137 }, (_, i) => ({
  uid: `dpl_release${String(i).padStart(3, "0")}`,
  id: `dpl_release${String(i).padStart(3, "0")}`,
  projectId: "prj_web",
  name: "web",
  state: i === 2 || i === 7 ? "ERROR" : "READY",
  readyState: i === 2 || i === 7 ? "ERROR" : "READY",
  target: "production",
  created: 1700000200000 - i * 1000,
  meta: { githubCommitSha: `sha_release_${i}`, githubCommitRef: "main" },
}));
type Row = Record<string, any>;
export function vercelDeployments(query: Row) {
  const all = [
    ...VERCEL_DEPLOYMENTS,
    { ...VERCEL_DEPLOYMENTS[0]!, id: "dpl_preview", uid: "dpl_preview", target: "preview" },
    { ...VERCEL_DEPLOYMENTS[0]!, id: "dpl_other", uid: "dpl_other", projectId: "prj_other" },
  ];
  const rows = all.filter(
    (d) =>
      (!query.projectId || d.projectId === query.projectId) &&
      (!query.target || d.target === query.target) &&
      (!query.state || d.state === query.state) &&
      (!query.until || d.created < Number(query.until)) &&
      (!query.since || d.created >= Number(query.since)),
  );
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
  const page = rows.slice(0, limit);
  return {
    deployments: page,
    pagination: { count: page.length, next: rows.length > limit ? page.at(-1)!.created : null },
  };
}

export function vercelStep2Dispatch(
  method: string,
  path: string,
  query: Row,
  body: Row,
  state: RestState,
  fault: boolean,
): { value: unknown; status?: number } | undefined {
  const ok = (value: unknown) => ({ value });
  if (method === "GET") {
    if (path === "/v2/user") return ok({ user: { id: "usr_alice", username: "alice" } });
    if (path === "/v2/teams")
      return ok({
        teams: [
          { id: "team_fake", slug: "studio", name: "Studio", membership: { role: "OWNER" } },
          { id: "team_other", slug: "other", name: "Other", membership: { role: "MEMBER" } },
        ],
        pagination: { next: null },
      });
    if (path === "/v10/projects") {
      const other = query.teamId === "team_other" || query.slug === "other";
      return ok({
        projects: [
          {
            id: other ? "prj_other" : "prj_web",
            name: other ? "other" : "web",
            accountId: other ? "team_other" : "team_fake",
          },
        ],
        pagination: { next: null },
      });
    }
    if (path === "/v9/projects/prj_web" || path === "/v9/projects/web")
      return ok({ id: "prj_web", name: "web", accountId: "team_fake" });
    if (path === "/v7/deployments") return ok(vercelDeployments(query));
    if (path.startsWith("/v13/deployments/")) return ok(VERCEL_DEPLOYMENTS.find((d) => path.endsWith(d.id)) ?? {});
    if (path === "/v2/deployments/dpl_release000/aliases")
      return ok({
        aliases: [{ uid: "als_web", alias: "web-prod.example.app", deploymentId: "dpl_release000" }],
        pagination: { next: null },
      });
    if (path === "/v9/projects/prj_web/domains")
      return ok({
        domains: [{ name: "app.example.com", projectId: "prj_web", verified: false }],
        pagination: { next: null },
      });
    if (path === "/v9/projects/prj_web/domains/app.example.com")
      return ok({
        name: "app.example.com",
        projectId: "prj_web",
        verified: false,
        verification: [{ type: "TXT", domain: "_vercel.app.example.com", value: "verify-abc", reason: "pending" }],
      });
    if (path === "/v3/deployments/dpl_release002/events")
      return ok([
        {
          type: "stderr",
          created: 1700000198000,
          payload: { text: "Build failed: missing widget.ts", info: { step: "compile" } },
        },
      ]);
    if (path === "/v1/projects/prj_web/deployments/dpl_release000/runtime-logs")
      return ok([
        {
          timestampInMs: 1700000201000,
          level: "error",
          message: "Request failed: widget timeout",
          requestPath: "/api/widget",
          responseStatusCode: 504,
        },
      ]);
    if (path === "/v10/projects/prj_web/env") return ok({ envs: state.envs });
  }
  if (method === "POST" && path === "/v10/projects/prj_web/env") {
    const existing = state.envs.find(
      (e) => e.key === body.key && JSON.stringify(e.target) === JSON.stringify(body.target),
    );
    if (existing && query.upsert !== "true")
      return ok({ failed: [{ error: { code: "ENV_ALREADY_EXISTS", message: "Stored value withheld" } }] });
    const env = existing ?? { id: "env_created" };
    Object.assign(env, body);
    if (!existing) state.envs.push(env);
    return ok({ created: env, failed: [] });
  }
  if (method === "PATCH" && path === "/v9/projects/prj_web/env/env_prod") {
    Object.assign(state.envs[0]!, body);
    if (fault && !state.vercelFaulted) {
      state.vercelFaulted = true;
      return {
        status: 500,
        value: { error: { code: "internal_server_error", message: "Acknowledgement lost after commit" } },
      };
    }
    return ok(state.envs[0]);
  }
  return undefined;
}
