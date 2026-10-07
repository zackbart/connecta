import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { buildSync } from "esbuild";

// Each fixture is a separate bundled module, not a renamed stand-in. In the
// Worker project it executes inside workerd with the native Loader binding.
function executorBundles() {
  const sources: Record<string, string> = {
    "virtual:connecta-minified-upstream": 'export { DynamicWorkerExecutor } from "@cloudflare/codemode";',
    "virtual:connecta-duplicate-worker": 'export { workerExecutor } from "./src/worker.ts";',
  };
  return {
    name: "connecta-executor-bundles",
    resolveId(id: string) { return id in sources ? `\0${id}` : undefined; },
    load(id: string) {
      const source = sources[id.slice(1)];
      if (!source) return;
      return buildSync({
        stdin: { contents: source, resolveDir: fileURLToPath(new URL(".", import.meta.url)) },
        bundle: true, format: "esm", platform: "neutral", minify: true,
        external: ["cloudflare:workers"], write: false,
      }).outputFiles[0]?.text;
    },
  };
}

// Every test/*.test.ts suite belongs to exactly one of these lists. The Node
// project runs both; the Workers project runs only the portable list.
// test/suite-partition.test.ts guards the partition, including itself.
export const WORKERS_SUITES = [
  "test/activity.test.ts",
  "test/access-tokens.test.ts",
  "test/api-connector.test.ts",
  "test/api-oauth.test.ts",
  "test/artifact-store.test.ts",
  "test/artifact-refresh.test.ts",
  "test/artifacts-connector.test.ts",
  "test/artifacts-routes.test.ts",
  "test/artifacts-markdown.test.ts",
  "test/artifacts-operations.test.ts",
  "test/artifacts-validate.test.ts",
  "test/asserted-principal.test.ts",
  "test/basecamp-provider.test.ts",
  "test/bearer.test.ts",
  "test/branding.test.ts",
  "test/breeze-provider.test.ts",
  "test/call-admission.test.ts",
  "test/call-admission-handoff.test.ts",
  "test/catalog-drift.test.ts",
  "test/catalog-flight-lifetimes.test.ts",
  "test/catalog-service.test.ts",
  "test/catalog.test.ts",
  "test/clerk.test.ts",
  "test/cloudflare-access-auth.test.ts",
  "test/cloudflare-provider.test.ts",
  "test/code-first-surface.test.ts",
  "test/codemode-compat.test.ts",
  "test/config.test.ts",
  "test/invocation-log.test.ts",
  "test/invocation-pipeline.test.ts",
  "test/optional-modules.test.ts",
  "test/credentials.test.ts",
  "test/d1-activity-example.test.ts",
  "test/downstream-oauth.test.ts",
  "test/errors.test.ts",
  "test/executor-admission.test.ts",
  "test/execute.test.ts",
  "test/execute-emit.test.ts",
  "test/guarded-fetch.test.ts",
  "test/guest-api-contract.test.ts",
  "test/identity-scope.test.ts",
  "test/linear-provider.test.ts",
  "test/meta-tools-call.test.ts",
  "test/meta-tools-search.test.ts",
  "test/meta-tool-schema-cache.test.ts",
  "test/meta-tool-schemas.test.ts",
  "test/meta-tools.test.ts",
  "test/mcp-subscriptions.test.ts",
  "test/mixpanel-provider.test.ts",
  "test/notion-provider.test.ts",
  "test/operator-boundary.test.ts",
  "test/operator-fix-prompts.test.ts",
  "test/operator-routes.test.ts",
  "test/operator-store.test.ts",
  "test/operator-ui-model.test.ts",
  "test/operator-view.test.ts",
  "test/program-source.test.ts",
  "test/program-writes.test.ts",
  "test/provider-conventions.test.ts",
  "test/provider-registry.test.ts",
  "test/registry.test.ts",
  "test/request-admission.test.ts",
  "test/request-pipeline.test.ts",
  "test/result-shapes.test.ts",
  "test/remote-mcp-credential.test.ts",
  "test/remote-mcp-pagination.test.ts",
  "test/remote-mcp-warm-catalog.test.ts",
  "test/remote-mcp.test.ts",
  "test/revenuecat-provider.test.ts",
  "test/runtime.test.ts",
  "test/runtime-admission.test.ts",
  "test/runtime-call-admission.test.ts",
  "test/runtime-services.test.ts",
  "test/server-route-contracts.test.ts",
  "test/server.test.ts",
  "test/startup-warnings.test.ts",
  "test/storage-cas.test.ts",
  "test/stripe-provider.test.ts",
  "test/typescript-signatures.test.ts",
  "test/ui.test.ts",
  "test/ui-credentials.test.ts",
  "test/url-safety.test.ts",
  "test/validate.test.ts",
  "test/vercel-provider.test.ts",
  "test/ccb-provider.test.ts",
  "test/planning-center-provider.test.ts",
  "test/overflow-provider.test.ts",
  "test/tithely-provider.test.ts",
  "test/google-workspace-delegation.test.ts",
  "test/gmail-provider.test.ts",
  "test/drive-provider.test.ts",
  "test/docs-provider.test.ts",
  "test/sheets-provider.test.ts",
  "test/slides-provider.test.ts",
  "test/forms-provider.test.ts",
] as const;

export const NODE_ONLY_SUITES = [
  {
    file: "test/ci-browser-paths.test.ts",
    reason: "spawns the Bash CI path filter and aggregate gate",
  },
  {
    file: "test/worker-budget-response.test.ts",
    reason: "runs real HTTP requests through Wrangler/workerd to verify Worker cleanup after the response ends",
  },
  {
    file: "test/invariants.test.ts",
    reason: "reads principles and parses test registrations from the checkout",
  },
  {
    file: "test/spec-coverage.test.ts",
    reason: "reads the MCP coverage record and resolves test titles on disk",
  },
  {
    file: "test/artifact-eval-grader.test.ts",
    reason: "checks the Node-only fake-world artifact evaluation grader",
  },
  {
    file: "test/codex-eval.test.ts",
    reason: "spawns a fake Codex app-server to verify eval protocol and cancellation",
  },
  {
    file: "test/artifact-store-d1.test.ts",
    reason:
      "drives the artifact store over the example D1 and R2 adapters through wrangler's getPlatformProxy",
  },
  {
    file: "test/artifact-store-file.test.ts",
    reason: "runs the artifact store over the Node filesystem storage adapter",
  },
  {
    file: "test/d1-storage-example.test.ts",
    reason:
      "drives the example D1 adapter through wrangler's getPlatformProxy local D1",
  },
  {
    file: "test/deployment-shapes.test.ts",
    reason: "walks the template and example trees with Node filesystem APIs",
  },
  {
    file: "test/doc-links.test.ts",
    reason: "spawns the Node documentation checker against filesystem fixtures",
  },
  {
    file: "test/doctor-cli.test.ts",
    reason: "spawns the CLI against a Node HTTP deployment over real sockets",
  },
  {
    file: "test/drift-check.test.ts",
    reason:
      "spawns the Node maintainer drift checker against filesystem fixtures",
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
    file: "test/packed-links.test.ts",
    reason: "spawns the Node packed-link gate against filesystem fixtures",
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
    file: "test/quickjs-pool.test.ts",
    reason: "mocks Node child-process forks to script child lifecycles",
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
    file: "test/typescript-signatures-parse.test.ts",
    reason:
      "loads the CommonJS TypeScript compiler to parse every rendered signature",
  },
  {
    file: "test/template-file-activity.test.ts",
    reason:
      "runs the Node template's filesystem activity store against real files",
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
        // The Node template is a consumer project: it imports the package by
        // name, and `dist/` does not exist yet when tests run. Point that one
        // exact specifier at the source entry so a suite may exercise template
        // code directly. Anchored so subpath specifiers never match — those
        // belong to the Node-only entries the template's own tsconfig maps.
        resolve: {
          alias: [
            { find: "@zackbart/connecta/activity", replacement: fileURLToPath(new URL("./src/activity.ts", import.meta.url)) },
            {
              find: /^@zackbart\/connecta$/,
              replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
            },
          ],
        },
        test: {
          name: "node",
          include: NODE_SUITES,
        },
      },
      {
        plugins: [
          executorBundles(),
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
