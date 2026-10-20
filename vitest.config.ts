import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import CoverageReporter from "./test/fixtures/coverage-reporter.js";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { build, buildSync, type Plugin } from "esbuild";
import { TEST_INCLUDE, NODE_ONLY_EXCLUDE } from "./scripts/test-suites.mjs";

// Each fixture is a separate bundled module, not a renamed stand-in. In the
// Worker project it executes inside workerd with the native Loader binding.
function executorBundles() {
  const sources: Record<string, string> = {
    "virtual:connecta-minified-upstream": 'export { DynamicWorkerExecutor } from "@cloudflare/codemode";',
    "virtual:connecta-duplicate-worker": 'export { workerExecutor } from "./src/worker.ts";',
  };
  return {
    name: "connecta-executor-bundles",
    resolveId(id: string) {
      return id in sources ? `\0${id}` : undefined;
    },
    load(id: string) {
      const source = sources[id.slice(1)];
      if (!source) return;
      return buildSync({
        stdin: { contents: source, resolveDir: fileURLToPath(new URL(".", import.meta.url)) },
        bundle: true,
        format: "esm",
        platform: "neutral",
        minify: true,
        conditions: ["workerd", "browser"],
        external: ["cloudflare:workers"],
        write: false,
      }).outputFiles[0]?.text;
    },
  };
}

// An organization-mode clerkAuth in a Worker of its own, with the Worker
// example's compatibility settings, so its Backend API fetches meet workerd's
// own Request validation and each request to it is a separate Worker request
// (test/clerk-organization-workerd.test.ts). Every outbound fetch it makes
// goes over TCP to the Clerk Backend API stand-in at `backend`. Built once
// when the project starts; restart a watch run after editing src/auth/clerk.ts.
async function clerkOrganizationWorker(backend: string) {
  const transport: Plugin = {
    name: "clerk-organization-transport",
    setup(bundle) {
      bundle.onResolve({ filter: /\/clerk-transport\.js$/ }, () => ({
        path: fileURLToPath(new URL("./test/fixtures/clerk-organization-transport.ts", import.meta.url)),
      }));
    },
  };
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("./test/fixtures/clerk-organization-worker.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*"],
    plugins: [transport],
    write: false,
  });
  return {
    name: "clerk-organization",
    modules: true,
    script: outputFiles[0]!.text,
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    outboundService: { external: { address: backend, http: {} } },
  };
}

export default defineConfig({
  test: {
    reporters: ["default", new CoverageReporter()],
    projects: [
      {
        // The deployment shapes are consumer projects: they import the package
        // by name, and `dist/` does not exist yet when tests run. Point each
        // specifier at its source module so a suite may run the template's and
        // the example's configuration directly. The two published subpaths
        // whose target is not `src/<subpath>.ts` come first.
        resolve: {
          alias: [
            {
              find: "@zackbart/connecta/quickjs",
              replacement: fileURLToPath(new URL("./src/executors/quickjs.ts", import.meta.url)),
            },
            {
              find: "@zackbart/connecta/auth/access-tokens",
              replacement: fileURLToPath(new URL("./src/access-tokens.ts", import.meta.url)),
            },
            {
              find: /^@zackbart\/connecta\/providers\/(.+)$/,
              replacement: `${fileURLToPath(new URL("./src/providers/", import.meta.url))}$1/index.ts`,
            },
            {
              find: /^@zackbart\/connecta\/(.+)$/,
              replacement: `${fileURLToPath(new URL("./src/", import.meta.url))}$1.ts`,
            },
            {
              find: /^@zackbart\/connecta$/,
              replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
            },
          ],
        },
        test: {
          name: "node",
          globalSetup: ["./test/fixtures/oauth-http-server.ts"],
          include: TEST_INCLUDE,
          exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/worktrees/**"],
        },
      },
      {
        plugins: [
          executorBundles(),
          cloudflareTest(async ({ inject }) => ({
            miniflare: {
              // Match the Worker example's compatibility date, plus a Worker
              // Loader so the guest API contract suite can run its cases
              // against a real Dynamic Worker executor rather than a
              // stand-in. Unlike the example, this also sets the
              // unhandled-rejection checkpoint flag below.
              compatibilityDate: "2025-01-01",
              // Before 2026-03-03, workerd reports a rejection as unhandled even
              // when its handler attaches later in the same microtask
              // checkpoint: an async `then` callback that throws before its
              // first await, or a pending read of a cancelled internal stream.
              // Report only what is still unhandled after the checkpoint, as
              // Node does. A rejection nothing handles still fails the run.
              compatibilityFlags: ["nodejs_compat", "unhandled_rejection_after_microtask_checkpoint"],
              workerLoaders: { LOADER: {} },
              // A real local Workers KV namespace and D1 database for the
              // one-shot KV → D1 copy (test/kv-to-d1.test.ts).
              kvNamespaces: ["KV_COPY_SOURCE"],
              d1Databases: ["KV_COPY_TARGET"],
              serviceBindings: { CLERK_ORGANIZATION: "clerk-organization" },
              workers: [await clerkOrganizationWorker(inject("clerkBackendServer"))],
            },
          })),
        ],
        test: {
          name: "workers",
          globalSetup: ["./test/fixtures/oauth-http-server.ts", "./test/fixtures/clerk-backend-server.ts"],
          include: TEST_INCLUDE,
          exclude: [...NODE_ONLY_EXCLUDE, "**/node_modules/**", "**/dist/**", "**/.claude/**", "**/worktrees/**"],
        },
      },
    ],
  },
});
