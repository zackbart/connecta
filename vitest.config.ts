import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Suites that also run inside workerd (Cloudflare's runtime) via
// @cloudflare/vitest-pool-workers, catching Workers-only regressions — e.g.
// anything relying on dynamic code generation, which workerd prohibits and
// Node happily allows. Excluded are the Node-only surfaces (fileStorage, the
// quickjs executor, and the fs-walking purity/package/version guardrails).
const WORKERS_SUITES = [
  "test/activity.test.ts",
  "test/api-connector.test.ts",
  "test/bearer.test.ts",
  "test/branding.test.ts",
  "test/catalog.test.ts",
  "test/codemode-compat.test.ts",
  "test/config.test.ts",
  "test/credential-health.test.ts",
  "test/credentials.test.ts",
  "test/downstream-oauth.test.ts",
  "test/errors.test.ts",
  "test/executor-admission.test.ts",
  "test/execute.test.ts",
  "test/meta-tools.test.ts",
  "test/registry.test.ts",
  "test/request-admission.test.ts",
  "test/remote-mcp-pagination.test.ts",
  "test/remote-mcp.test.ts",
  "test/server.test.ts",
  "test/toolkits.test.ts",
  "test/ui.test.ts",
  "test/validate.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              // Match the Worker example's runtime configuration.
              compatibilityDate: "2025-01-01",
              compatibilityFlags: ["nodejs_compat"],
            },
          }),
        ],
        test: {
          name: "workers",
          include: WORKERS_SUITES,
        },
      },
    ],
  },
});
