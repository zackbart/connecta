import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import CoverageReporter from "./test/fixtures/coverage-reporter.js";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { build, buildSync, type Plugin } from "esbuild";

const EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/worktrees/**"];

// Enroll suites that need Workers bindings/the Worker executor or exercise
// workerd-specific fetch, streams, rejections, Web Crypto, or provider bytes.
// Pure logic runs only on Node; never list a *.node.test.ts suite.
const WORKERS_SUITES = [
  // Native UTF-8/Web Crypto content identity across physical index formats.
  "test/compact-index.test.ts",
  "test/storage-sql-d1.test.ts",
  // Workers bindings and isolates: D1, KV, the Worker Loader executor, and
  // service-bound Workers. These skip or fail outside workerd.
  "test/auth-admission-binding.test.ts",
  "test/auth-admission-live.test.ts",
  "test/auth-admission-workerd.test.ts",
  "test/catalog-cache.test.ts",
  "test/clerk-organization-workerd.test.ts",
  "test/codemode-compat.test.ts",
  "test/executor-native.test.ts",
  "test/guest-api-contract.test.ts",
  "test/kv-to-d1.test.ts",
  "test/usage-guide.test.ts",
  // workerd's own fetch, stream, timer and unhandled-rejection behaviour,
  // through real sockets and the MCP SDK edges.
  "test/call-services.test.ts",
  "test/guarded-transport-parity.test.ts",
  "test/oauth-grant-parity.test.ts",
  "test/auth-native.test.ts",
  "test/auth-metadata-challenge.test.ts",
  "test/call-revocation.test.ts",
  "test/call-auxiliary-lifetime.test.ts",
  "test/call-renewal-lifetime.test.ts",
  "test/oauth-preparation-lifetime.test.ts",
  "test/cancellation-faults.test.ts",
  "test/operation-cancellation.test.ts",
  "test/remote-mcp-renewal-lifetime.test.ts",
  "test/direct-write-finalizer.test.ts",
  "test/mcp-core.test.ts",
  "test/upward-native.test.ts",
  "test/skills-extension.test.ts",
  "test/oauth-refresh-http.test.ts",
  "test/write-unauthorized-oauth.test.ts",
  "test/remote-mcp.test.ts",
  "test/remote-mcp-native.test.ts",
  "test/remote-mcp-skills.test.ts",
  "test/remote-mcp-headers.test.ts",
  "test/server.test.ts",
  "test/native-tools.test.ts",
  "test/unhandled-rejections.test.ts",
  // Native response reads can print sensitive downstream text below JS sinks.
  // workerd-native-output.node.test.ts also invokes these three by filename.
  "test/operator-sinks.test.ts",
  // Browser store fetch/body ordering and recovery deadlines on native timers.
  "test/operator-store.test.ts",
  "test/operator-agent-state.test.ts",
  "test/clerk-operator-output.test.ts",
  "test/byte-read-response.test.ts",
  "test/write-evidence.test.ts",
  "test/write-provenance.test.ts",
  // Web Crypto: access tokens, the credential vault, Clerk and Access JWTs.
  "test/access-tokens.test.ts",
  "test/vercel-agent.test.ts",
  "test/clerk.test.ts",
  "test/cloudflare-access-auth.test.ts",
  "test/credentials.test.ts",
  // Provider pin policy crosses native fetch, request budgets and Web Crypto cursors.
  "src/providers/vercel/provider.pin.test.ts",
  "src/providers/planning-center/provider.pagination.test.ts",
  // Mixed suites use Vitest tags: only their native boundary cases rerun here.
  // Brace globs tolerate deleted files without enrolling other suites.
  "test/{http-kit,http-hatch,http-provider}.test.ts",
  "test/{oauth-token-redirect,downstream-revocation-http,oauth-refresh-resolution,mcp-body-bounds,mcp-subscriptions,request-admission,request-pipeline,clerk-transport,clerk-policy-cancellation,google-workspace-delegation,auth-elicitation,downstream-input}.test.ts",
];

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
// per config load; restart watch mode after editing this fixture or any
// bundled dependency (including src/auth/clerk.ts).
let clerkOrganizationScript: Promise<string> | undefined;
async function clerkOrganizationWorker(backend: string) {
  const transport: Plugin = {
    name: "clerk-organization-transport",
    setup(bundle) {
      bundle.onResolve({ filter: /\/clerk-transport\.js$/ }, () => ({
        path: fileURLToPath(new URL("./test/fixtures/clerk-organization-transport.ts", import.meta.url)),
      }));
    },
  };
  clerkOrganizationScript ??= build({
    entryPoints: [fileURLToPath(new URL("./test/fixtures/clerk-organization-worker.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*"],
    plugins: [transport],
    write: false,
  }).then(({ outputFiles }) => outputFiles[0]!.text);
  return {
    name: "clerk-organization",
    modules: true,
    script: await clerkOrganizationScript,
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    outboundService: { external: { address: backend, http: {} } },
  };
}

// cloudflareTest resolves its options on every pool worker start, once per
// test file. Bundle each fixture once per run, off the event loop: a
// synchronous build there stalls the host serving running tests' imports.
// This cache lasts until config reload: restart watch mode after changing a
// fixture entry or any of its bundled dependencies.
const fixtureBundles = new Map<string, Promise<string>>();
function fixtureBundle(entry: string): Promise<string> {
  let text = fixtureBundles.get(entry);
  if (!text) {
    text = build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      write: false,
    }).then(({ outputFiles }) => outputFiles[0]!.text);
    fixtureBundles.set(entry, text);
  }
  return text;
}

// A separate native Worker: requests share no test-request I/O or promises.
// enable_weak_ref matches the Worker example, so a charge whose work workerd
// cancelled can be released by the collector (src/auth-admission.ts).
async function authAdmissionWorker(backend?: string) {
  return {
    name: backend ? "auth-admission-sdk" : "auth-admission",
    ...(backend ? { outboundService: { external: { address: backend, http: {} } } } : {}),
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal", "enable_weak_ref"],
    modules: true,
    script: await fixtureBundle(
      backend ? "./test/fixtures/auth-admission/clerk.ts" : "./test/fixtures/auth-admission/index.ts",
    ),
  };
}

// The plain Worker export plus named middleware and control entrypoints
// sharing its isolate.
async function authAdmissionEntryWorker(name: string, origin: string) {
  return {
    name,
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal", "service_binding_extra_handlers", "enable_weak_ref"],
    bindings: { ORIGIN: origin },
    serviceBindings: { SELF: name },
    modules: true,
    script: await fixtureBundle("./test/fixtures/auth-admission/entry.ts"),
  };
}

// One fresh isolate per collection scenario (test/auth-admission-binding.test.ts):
// in this harness, objects left unreachable by an earlier scenario's cancelled
// invocations were seen to keep later ones reachable in the same isolate.
const AUTH_ADMISSION_ENTRY_ISOLATES = ["middleware", "ended"];
const bindingName = (key: string) => `AUTH_ADMISSION_${key.toUpperCase().replaceAll("-", "_")}`;

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
          tags: [{ name: "node" }, { name: "workers" }],
          globalSetup: [
            "./test/fixtures/oauth-http-server.ts",
            "./test/fixtures/transport-evidence-server.ts",
            "./test/fixtures/remote-mcp-attempt-server.ts",
            "./test/fixtures/auth-admission-server.ts",
          ],
          include: ["test/**/*.test.ts", "src/providers/**/*.test.ts"],
          exclude: EXCLUDE,
        },
      },
      {
        plugins: [
          executorBundles(),
          cloudflareTest(async ({ inject }) => ({
            miniflare: {
              // Match the Worker example's compatibility date, rejection
              // reporting, and weak references, plus a Worker Loader so the
              // guest API contract suite can run against a real Dynamic
              // Worker executor.
              compatibilityDate: "2025-01-01",
              // Before 2026-03-03, workerd reports a rejection as unhandled even
              // when its handler attaches later in the same microtask
              // checkpoint: an async `then` callback that throws before its
              // first await, or a pending read of a cancelled internal stream.
              // Report only what is still unhandled after the checkpoint, as
              // Node does. A rejection nothing handles still fails the run.
              // enable_weak_ref exposes FinalizationRegistry, which releases an
              // authentication charge whose pending work became unreachable.
              compatibilityFlags: [
                "nodejs_compat",
                "unhandled_rejection_after_microtask_checkpoint",
                "enable_weak_ref",
              ],
              workerLoaders: { LOADER: {} },
              // A real local Workers KV namespace and D1 database for the
              // one-shot KV → D1 copy (test/kv-to-d1.test.ts).
              kvNamespaces: ["KV_COPY_SOURCE"],
              d1Databases: ["KV_COPY_TARGET"],
              serviceBindings: {
                CLERK_ORGANIZATION: "clerk-organization",
                SQL_LIFETIMES: "sql-lifetimes",
                AUTH_ADMISSION: "auth-admission",
                AUTH_ADMISSION_SDK: "auth-admission-sdk",
                ...Object.fromEntries(
                  AUTH_ADMISSION_ENTRY_ISOLATES.map((key) => `entry-${key}`).flatMap((key) => [
                    [bindingName(key), `auth-admission-${key}`],
                    [`${bindingName(key)}_CONTROL`, { name: `auth-admission-${key}`, entrypoint: "control" }],
                    [`${bindingName(key)}_MIDDLEWARE`, { name: `auth-admission-${key}`, entrypoint: "middleware" }],
                  ]),
                ),
              },
              workers: await Promise.all([
                {
                  name: "sql-lifetimes",
                  modules: true,
                  script: await fixtureBundle("./test/fixtures/d1-native-worker.ts"),
                  compatibilityDate: "2025-01-01",
                  compatibilityFlags: ["nodejs_compat"],
                  d1Databases: { DB: "sql-lifetimes" },
                },
                clerkOrganizationWorker(inject("clerkBackendServer")),
                authAdmissionWorker(),
                authAdmissionWorker(new URL(inject("authAdmissionServer")).host),
                ...AUTH_ADMISSION_ENTRY_ISOLATES.map((key) =>
                  authAdmissionEntryWorker(`auth-admission-entry-${key}`, inject("authAdmissionServer")),
                ),
              ]),
            },
          })),
        ],
        test: {
          name: "workers",
          tags: [{ name: "node", skip: true }, { name: "workers" }],
          globalSetup: [
            "./test/fixtures/oauth-http-server.ts",
            "./test/fixtures/clerk-backend-server.ts",
            "./test/fixtures/transport-evidence-server.ts",
            "./test/fixtures/remote-mcp-attempt-server.ts",
            "./test/fixtures/auth-admission-server.ts",
          ],
          include: WORKERS_SUITES,
          exclude: EXCLUDE,
        },
      },
    ],
  },
});
