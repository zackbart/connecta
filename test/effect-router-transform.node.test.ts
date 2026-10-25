// Node-only: mutation probes compile the real production and frozen legacy graphs.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/probes/effect-router-transform.mjs", import.meta.url).href;
const { baselineSource, candidateSource, routerCandidate } = (await import(moduleUrl)) as {
  baselineSource(source: string): string;
  candidateSource(source: string): string;
  routerCandidate(options?: { legacy?: boolean; filter?: RegExp }): import("esbuild").Plugin;
};

describe("production router proof enforcement", () => {
  for (const legacy of [true, false])
    it(`rejects a missed ${legacy ? "legacy" : "production"} graph even when compilation succeeds`, async () => {
      const options = {
        entryPoints: ["src/server.ts"],
        bundle: true,
        format: "esm" as const,
        platform: "neutral" as const,
        conditions: ["workerd", "worker", "browser", "import"],
        external: ["node:*"],
        write: false,
        logLevel: "silent" as const,
      };
      await build(options);
      await expect(
        build({ ...options, plugins: [routerCandidate({ legacy, filter: /never-match-server/ })] }),
      ).rejects.toThrow("Proof router transform count 0; expected exactly 1");
    });

  it("pins the frozen dispatcher and rejects a candidate that bypasses production dispatch", async () => {
    const legacy = await readFile(new URL("./fixtures/effect-proof/legacy-server.ts.txt", import.meta.url), "utf8");
    expect(baselineSource(legacy)).toBe(legacy);
    expect(() => baselineSource(legacy.replace("const route =", "const routeRenamed ="))).toThrow(
      "Frozen legacy dispatcher changed",
    );
    const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
    const candidate = candidateSource(source);
    expect(candidate.startsWith(source)).toBe(true);
    expect(() =>
      candidateSource(source.replace("const route = createRouteDispatcher", "const route = bypass")),
    ).toThrow("Production router proof drift");
    expect(() => candidateSource(candidate)).toThrow("Production router proof drift");
  });

  it("detects removal of actual route selection and unmatched fallthrough", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-router-mutation-"));
    try {
      const statuses: unknown[] = [];
      for (const mutation of ["none", "selection", "unmatched", "reentry"]) {
        const result = await build({
          stdin: {
            contents: `import { createRouteDispatcher } from "./src/routes/dispatch.js";
              import { Effect } from "effect";
              import * as HttpServerError from "effect/http/HttpServerError";
              import * as HttpServerRequest from "effect/http/HttpServerRequest";
              import { runEdge } from "./src/runtime/run.js";
              let failure, calls = 0;
              const route = createRouteDispatcher(() => { calls++; return failure ? Effect.fail(failure) : Effect.succeed(null); }, () => Effect.succeed(null), async () => new Response("ok"));
              export async function probe(path) {
                const request = new Request("https://test.invalid" + path);
                try { return (await runEdge(route({ request, url: new URL(request.url), path, baseUrl: "https://test.invalid", opts: { config: {} } }))).status; }
                catch { return "unhandled"; }
              }
              export async function applicationErrorCalls() {
                const request = new Request("https://test.invalid/mcp");
                failure = new HttpServerError.HttpServerError({ reason: new HttpServerError.RouteNotFound({ request: HttpServerRequest.fromWeb(request) }) });
                calls = 0;
                try { await runEdge(route({ request, url: new URL(request.url), path: "/mcp", baseUrl: "https://test.invalid", opts: { config: {} } })); } catch {}
                return calls;
              }`,
            resolveDir: process.cwd(),
            loader: "ts",
          },
          bundle: true,
          format: "esm",
          platform: "neutral",
          conditions: ["workerd", "worker", "browser", "import"],
          external: ["node:*"],
          write: false,
          logLevel: "silent",
          plugins: [
            {
              name: "mutation",
              setup(bundle) {
                bundle.onLoad({ filter: /\/src\/routes\/dispatch\.ts$/ }, async ({ path }) => {
                  let contents = await readFile(path, "utf8");
                  if (mutation !== "none") {
                    const before = mutation === "selection" ? '"/health",' : "!current.entered &&";
                    expect(contents.split(before)).toHaveLength(2);
                    contents = contents.replace(
                      before,
                      mutation === "selection" ? '"/removed-health",' : mutation === "reentry" ? "" : "false &&",
                    );
                  }
                  return { contents, loader: "ts" };
                });
              },
            },
          ],
        });
        const file = join(directory, `${mutation}.mjs`);
        await writeFile(file, result.outputFiles[0]!.contents);
        const { probe, applicationErrorCalls } = await import(pathToFileURL(file).href);
        statuses.push([await probe("/health"), await probe("/missing"), await applicationErrorCalls()]);
      }
      expect(statuses).toEqual([
        [200, 404, 1],
        [404, 404, 1],
        [200, "unhandled", 1],
        [200, 404, 2],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
