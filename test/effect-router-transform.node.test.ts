// Node-only: mutation tests run esbuild and a nested Vitest against actual source.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/probes/effect-router-transform.mjs", import.meta.url).href;
const { candidateSource, routerCandidate } = (await import(moduleUrl)) as {
  candidateSource(source: string): string;
  routerCandidate(options?: { filter?: RegExp }): import("esbuild").Plugin;
};

describe("proof router transform enforcement", () => {
  it("rejects a valid compiled baseline when the esbuild filter misses server.ts", async () => {
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
    await expect(build({ ...options, plugins: [routerCandidate({ filter: /never-match-server/ })] })).rejects.toThrow(
      "Proof router transform count 0; expected exactly 1",
    );
  });

  it("rejects structural drift and repeated transforms, and emits a runtime marker for a real match", async () => {
    const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
    const transformed = candidateSource(source);
    expect(transformed).toContain("export const CONNECTA_PROOF_ROUTER_TRANSFORM = true");
    expect(() => candidateSource(source.replace("const route =", "const routeRenamed ="))).toThrow(
      "Proof route transform drift",
    );
    expect(() => candidateSource(transformed)).toThrow("Proof route transform drift");
  });

  for (const project of ["node", "workers"])
    it(`rejects a missing Vitest transform in the actual ${project} runtime`, async () => {
      let failure: { code?: number; stdout?: string; stderr?: string } | undefined;
      try {
        await promisify(execFile)(
          process.execPath,
          [
            "node_modules/vitest/vitest.mjs",
            "run",
            "--config",
            "scripts/probes/effect-router.vitest.config.mjs",
            "--project",
            project,
            "test/downstream-auth-best-practice.test.ts",
          ],
          {
            env: { ...process.env, CONNECTA_PROOF_MUTATION: "miss-server", VITEST_MAX_WORKERS: "2" },
            timeout: 90_000,
            maxBuffer: 2_000_000,
          },
        );
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure?.code).toBe(1);
      expect((failure?.stdout ?? "") + (failure?.stderr ?? "")).toContain(
        "Proof router candidate transform was not applied in this Vitest runtime",
      );
    }, 100_000);
});
