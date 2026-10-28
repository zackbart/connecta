import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { build, buildSync, type Plugin } from "esbuild";

const EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/worktrees/**"];

// workerd runs only suites that need real Workers bindings or isolates: D1,
// KV, the Worker Loader executor, and service-bound Workers. Every other
// suite runs once, on Node. Never list a *.node.test.ts suite.
const WORKERS_SUITES = [
  "test/storage-sql-d1.test.ts",
  "test/catalog-cache.test.ts",
  "test/usage-guide.test.ts",
  "test/executor-native.test.ts",
  "test/executor-requests.test.ts",
  "test/guest-api-contract.test.ts",
  "test/codemode-compat.test.ts",
  "test/auth-admission-binding.test.ts",
  "test/auth-admission-live.test.ts",
  "test/auth-admission-workerd.test.ts",
  "test/clerk-organization-workerd.test.ts",
  "test/remote-mcp-principal-forwarding.test.ts",
  "test/unhandled-rejections.test.ts",
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

// The pool runs Miniflare 5, which cannot take an `external` socket as a
// Worker's `outboundService` (only as a service binding). Route the Worker's
// outbound fetches to a forwarding Worker whose binding is that TCP socket, so
// every request still leaves workerd over TCP to `address`, after the calling
// Worker's own Request validation and with workerd's own cancellation.
function externalOutbound(name: string, address: string) {
  return {
    name,
    modules: true,
    script: "export default { fetch: (request, env) => env.EXTERNAL.fetch(request) };",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    serviceBindings: { EXTERNAL: { external: { address, http: {} } } },
  };
}

// An organization-mode clerkAuth in a Worker of its own, with the Worker
// example's compatibility settings, so its Backend API fetches meet workerd's
// own Request validation and each request to it is a separate Worker request
// (test/clerk-organization-workerd.test.ts). Every outbound fetch it makes
// goes over TCP, through its outbound Worker, to the Clerk Backend API stand-in. Built once
// per config load; restart watch mode after editing this fixture or any
// bundled dependency (including src/auth/clerk.ts).
let clerkOrganizationScript: Promise<string> | undefined;
async function clerkOrganizationWorker() {
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
    outboundService: "clerk-organization-outbound",
  };
}

// cloudflareTest resolves its options on every pool worker start, once per
// test file. Bundle each fixture once per run, off the event loop: a
// synchronous build there stalls the host serving running tests' imports.
// This cache lasts until config reload: restart watch mode after changing a
// fixture entry or any of its bundled dependencies.
const fixtureBundles = new Map<string, Promise<string>>();
function fixtureBundle(entry: string, external?: string[]): Promise<string> {
  let text = fixtureBundles.get(entry);
  if (!text) {
    text = build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      ...(external ? { external } : {}),
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
    ...(backend ? { outboundService: "auth-admission-sdk-outbound" } : {}),
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

// Overlapping execute_code programs through the real Worker Loader executor
// (test/executor-requests.test.ts). Each call through its binding is a separate
// workerd request; host calls fetch the slow fixture route over TCP. The date
// is past 2025-06-16, where workerd binds async-context frames to requests.
async function executorRequestsWorker(origin: string) {
  return {
    name: "executor-requests",
    modules: true,
    script: await fixtureBundle("./test/fixtures/executor-requests.ts", ["cloudflare:workers", "node:*"]),
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    bindings: { ORIGIN: origin },
    workerLoaders: { LOADER: {} },
  };
}

export default defineConfig({
  test: {
    // Vitest 5 enables the persistent module cache by default. Under a full
    // run, @cloudflare/vitest-plugin's workerd runtime exits mid-file when its
    // modules come from that cache, so every run transforms afresh, as Vitest 4 did.
    fsModuleCache: false,
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
          allowOnly: false,
          tags: [{ name: "node" }, { name: "workers" }],
          globalSetup: [
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
              // Native D1 for the SQL and catalog cache contracts.
              d1Databases: ["STORAGE_DB"],
              serviceBindings: {
                CLERK_ORGANIZATION: "clerk-organization",
                // A first-party MCP downstream whose identity entrypoint only a binding reaches.
                NOTES_MCP: { name: "notes-mcp", entrypoint: "connecta" },
                NOTES_PUBLIC: "notes-mcp",
                NOTES_RPC: { name: "notes-mcp", entrypoint: "NotesRpc" },
                AUTH_ADMISSION: "auth-admission",
                AUTH_ADMISSION_SDK: "auth-admission-sdk",
                EXECUTOR_REQUESTS: "executor-requests",
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
                  name: "notes-mcp",
                  modules: true,
                  script: await fixtureBundle("./test/fixtures/notes-binding-worker.ts", ["cloudflare:workers"]),
                  compatibilityDate: "2025-01-01",
                  compatibilityFlags: ["nodejs_compat"],
                },
                clerkOrganizationWorker(),
                externalOutbound("clerk-organization-outbound", inject("clerkBackendServer")),
                authAdmissionWorker(),
                authAdmissionWorker(new URL(inject("authAdmissionServer")).host),
                externalOutbound("auth-admission-sdk-outbound", new URL(inject("authAdmissionServer")).host),
                executorRequestsWorker(inject("authAdmissionServer")),
                ...AUTH_ADMISSION_ENTRY_ISOLATES.map((key) =>
                  authAdmissionEntryWorker(`auth-admission-entry-${key}`, inject("authAdmissionServer")),
                ),
              ]),
            },
          })),
        ],
        test: {
          name: "workers",
          allowOnly: false,
          tags: [{ name: "node", skip: true }, { name: "workers" }],
          globalSetup: ["./test/fixtures/clerk-backend-server.ts", "./test/fixtures/auth-admission-server.ts"],
          include: WORKERS_SUITES,
          exclude: EXCLUDE,
        },
      },
    ],
  },
});
