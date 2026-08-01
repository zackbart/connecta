import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Every test/*.test.ts suite belongs to exactly one of these lists. The Node
// project runs both; the Workers project runs only the portable list.
// test/suite-partition.test.ts guards the partition, including itself.
export const WORKERS_SUITES = [
  "test/access-tokens.test.ts",
  "test/activity.test.ts",
  "test/api-connector.test.ts",
  "test/bearer.test.ts",
  "test/branding.test.ts",
  "test/call-admission.test.ts",
  "test/catalog.test.ts",
  "test/clerk.test.ts",
  "test/code-first-surface.test.ts",
  "test/codemode-compat.test.ts",
  "test/config.test.ts",
  "test/credentials.test.ts",
  "test/d1-activity-example.test.ts",
  "test/downstream-oauth.test.ts",
  "test/errors.test.ts",
  "test/executor-admission.test.ts",
  "test/execute.test.ts",
  "test/execute-emit.test.ts",
  "test/execute-ui.test.ts",
  "test/guest-api-contract.test.ts",
  "test/meta-tools.test.ts",
  "test/registry.test.ts",
  "test/request-admission.test.ts",
  "test/remote-mcp-pagination.test.ts",
  "test/remote-mcp.test.ts",
  "test/server-route-contracts.test.ts",
  "test/server.test.ts",
  "test/startup-warnings.test.ts",
  "test/ui.test.ts",
  "test/validate.test.ts",
] as const;

export const NODE_ONLY_SUITES = [
  {
    file: "test/doc-links.test.ts",
    reason: "spawns the Node documentation checker against filesystem fixtures",
  },
  {
    file: "test/file-storage.test.ts",
    reason: "exercises the Node filesystem storage adapter",
  },
  {
    file: "test/guest-api-contract-quickjs.test.ts",
    reason: "runs the guest API contract cases on the Node QuickJS executor",
  },
  {
    file: "test/node.test.ts",
    reason: "exercises the Node HTTP adapter over real TCP sockets",
  },
  {
    file: "test/package-surface.test.ts",
    reason: "walks the package tree with Node filesystem APIs",
  },
  {
    file: "test/purity.test.ts",
    reason: "walks the source import graph with Node filesystem APIs",
  },
  {
    file: "test/quickjs-child-entry.test.ts",
    reason: "mocks Node child-process and filesystem APIs",
  },
  {
    file: "test/quickjs-child-stderr.test.ts",
    reason: "mocks Node child-process streams",
  },
  {
    file: "test/quickjs-executor.test.ts",
    reason: "runs the Node QuickJS child-process executor",
  },
  {
    file: "test/quickjs-log-limits.test.ts",
    reason: "runs the Node QuickJS child-process executor",
  },
  {
    file: "test/suite-partition.test.ts",
    reason: "walks the test directory to guard this partition",
  },
  {
    file: "test/version.test.ts",
    reason: "reads package.json with Node filesystem APIs",
  },
] as const;

const NODE_SUITES = [
  ...WORKERS_SUITES,
  ...NODE_ONLY_SUITES.map(({ file }) => file),
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: NODE_SUITES,
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              // Match the Worker example's runtime configuration, plus a
              // Worker Loader so the guest API contract suite can run its
              // cases against a real Dynamic Worker executor rather than a
              // stand-in.
              compatibilityDate: "2025-01-01",
              compatibilityFlags: ["nodejs_compat"],
              workerLoaders: { LOADER: {} },
            },
          }),
        ],
        test: {
          name: "workers",
          include: [...WORKERS_SUITES],
        },
      },
    ],
  },
});
