import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import CoverageReporter from "./test/fixtures/coverage-reporter.js";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { buildSync } from "esbuild";
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

export default defineConfig({
  test: {
    reporters: ["default", new CoverageReporter()],
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
          include: TEST_INCLUDE,
          exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/worktrees/**"],
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
          include: TEST_INCLUDE,
          exclude: [...NODE_ONLY_EXCLUDE, "**/node_modules/**", "**/dist/**", "**/.claude/**", "**/worktrees/**"],
        },
      },
    ],
  },
});
