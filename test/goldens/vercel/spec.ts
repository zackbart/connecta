import { vercel } from "../../../src/providers/vercel/index.js";
import { defineGoldenSpec } from "../harness.js";

const VERCEL_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "bad_request",
  429: "rate_limited",
  500: "internal_server_error",
};

const ndjson = (rows: unknown[]) => ({
  headers: { "content-type": "application/stream+json" },
  text: rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
});

export default defineGoldenSpec({
  provider: "vercel",
  create: () =>
    vercel("hosting", { purpose: "Production web applications", auth: { type: "token" }, teamId: "team_default" }),
  credential: "golden-vercel-token/123+456=",
  failureReply: (status, message) => ({
    status,
    body: { error: { code: VERCEL_CODES[status] ?? `golden_${status}`, message: `${message}.` } },
  }),
  calls: [
    { tool: "vercel_api_search", args: { query: "project env", method: "PATCH", limit: 2 } },
    { tool: "vercel_api_details", args: { method: "GET", path: "/v7/deployments", param: "until" } },
    {
      tool: "vercel_api_read",
      args: {
        path: "/v7/deployments",
        query: { projectId: "web", limit: 2 },
        select: ["deployments.uid", "deployments.state"],
      },
      replies: [
        {
          body: {
            deployments: [
              { uid: "dpl_1", state: "ERROR", creator: { email: "alice@example.com" } },
              { uid: "dpl_2", state: "READY" },
            ],
            pagination: { count: 2, next: 1_700_000_000_000, prev: 1_700_000_100_000 },
          },
        },
      ],
    },
    {
      tool: "vercel_api_write",
      args: { method: "PATCH", path: "/v9/projects/web", body: { framework: "nextjs" } },
      replies: [{ body: { id: "prj_1", name: "web", framework: "nextjs", accountId: "team_default" } }],
    },
    {
      tool: "list_teams",
      args: { limit: 5 },
      replies: [
        {
          body: {
            teams: [
              { id: "team_1", slug: "acme", name: "Acme", membership: { role: "OWNER" }, billing: { plan: "pro" } },
            ],
            pagination: { count: 1, next: 1_699_000_000_000, prev: null },
          },
        },
      ],
    },
    {
      tool: "list_project_env_vars",
      args: { projectId: "web app", gitBranch: "main" },
      replies: [
        {
          body: {
            envs: [
              {
                id: "env_1",
                key: "API_KEY",
                type: "encrypted",
                target: ["production"],
                value: "encrypted-or-plain",
                createdAt: 1,
              },
            ],
          },
        },
      ],
    },
    {
      tool: "upsert_project_env_var",
      args: {
        projectId: "web",
        teamId: null,
        key: "TOKEN",
        value: "golden-env-value",
        type: "sensitive",
        targets: ["preview"],
        upsert: false,
      },
      replies: [
        {
          body: {
            created: { id: "env_2", key: "TOKEN", type: "sensitive", value: "golden-env-value", target: ["preview"] },
          },
        },
      ],
    },
    {
      tool: "update_project_env_var",
      args: { projectId: "web", envVarId: "env_2", targets: ["preview", "development"], comment: "Rotated" },
      replies: [
        {
          body: {
            id: "env_2",
            key: "TOKEN",
            type: "sensitive",
            target: ["preview", "development"],
            comment: "Rotated",
            updatedAt: 2,
          },
        },
      ],
    },
    {
      tool: "delete_project_env_var",
      args: { projectId: "web", envVarId: "env_2" },
      replies: [{ status: 204 }],
    },
    {
      tool: "get_deployment_build_logs",
      args: { deploymentId: "dpl_1", direction: "backward", limit: 50 },
      replies: [
        {
          body: [
            {
              type: "command",
              created: 1,
              payload: { text: "npm run build", info: { type: "build", name: "bld_1" } },
            },
            { type: "stderr", created: 2, payload: { text: "Error: Cannot find module 'x'", deploymentId: "dpl_1" } },
          ],
        },
      ],
    },
    {
      tool: "get_runtime_logs",
      args: { projectId: "web", deploymentId: "dpl_1", waitMs: 1000, levels: ["error"] },
      replies: [
        ndjson([
          { timestampInMs: 1, level: "info", message: "GET /", source: "serverless" },
          {
            timestampInMs: 2,
            level: "error",
            message: "TypeError: x is undefined",
            requestMethod: "GET",
            requestPath: "/api",
            responseStatusCode: 500,
          },
        ]),
      ],
    },
    {
      tool: "vercel_api_upload",
      args: { method: "POST", path: "/v2/files", base64Body: btoa("hello") },
      replies: [{ body: {} }],
    },
    {
      label: "vercel_api_upload PUT text",
      tool: "vercel_api_upload",
      args: { method: "PUT", path: "/v8/artifacts/abc123", textBody: "artifact" },
      replies: [{ status: 202, body: { urls: [] } }],
    },
  ],
  echo: {
    tool: "vercel_api_read",
    args: { path: "/v7/deployments", query: { projectId: "web" } },
    replies: (text) => [{ body: { deployments: [{ uid: "dpl_1", state: "ERROR", errorMessage: text }] } }],
  },
  failures: {
    read: { tool: "vercel_api_read", args: { path: "/v7/deployments", query: { projectId: "web" } } },
    write: {
      tool: "vercel_api_write",
      args: { method: "PATCH", path: "/v9/projects/web", body: { framework: "nextjs" } },
    },
  },
});
