// Characterization goldens: each maintained `api()` provider's catalog, the
// requests and results of its fixture calls, and its failure mapping, compared
// byte for byte with test/goldens/<provider>/*.json. `pnpm run goldens:update`
// rewrites them; this suite only compares. See the contributor section of
// documentation/architecture.md.
import { describe, expect, it } from "vitest";
import { GOLDEN_FILES, captureGoldens, uncoveredTools, type GoldenSpec } from "./goldens/harness.js";

// Vite's transform; the repository does not load vite/client types.
declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options?: { import?: string; query?: string; eager?: boolean }): Record<string, T>;
  }
}

const specs = import.meta.glob<GoldenSpec>("./goldens/*/spec.ts", { import: "default", eager: true });
const stored = import.meta.glob<string>("./goldens/*/*.json", { query: "?raw", import: "default", eager: true });
const providerFolders = Object.keys(import.meta.glob("../src/providers/*/index.ts")).map((path) => path.split("/")[3]!);

/** Maintained providers with no `api()` surface: hosted remote MCP only. */
const REMOTE_MCP_ONLY = ["basecamp", "intercom", "linear", "revenuecat", "wispr-flow"];

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const updating = env.CONNECTA_GOLDENS_UPDATE === "1";
const only = env.CONNECTA_GOLDENS_ONLY?.split(",").filter(Boolean);

const byProvider = Object.values(specs)
  .filter((spec) => !only || only.includes(spec.provider))
  .sort((a, b) => a.provider.localeCompare(b.provider));

describe("characterization goldens", () => {
  it.skipIf(only)("cover every maintained api() provider", () => {
    const covered = Object.values(specs).map((spec) => spec.provider);
    expect([...covered, ...REMOTE_MCP_ONLY].sort()).toEqual([...providerFolders].sort());
    for (const [path, spec] of Object.entries(specs)) expect(path).toBe(`./goldens/${spec.provider}/spec.ts`);
    // No golden outlives its spec, and no folder holds a file the harness does not write.
    const expected = covered.flatMap((provider) => GOLDEN_FILES.map((file) => `./goldens/${provider}/${file}.json`));
    expect(Object.keys(stored).sort()).toEqual(expected.sort());
  });

  for (const spec of byProvider) {
    it(`${spec.provider}: catalog, fixture calls, and failure mapping match the goldens`, async () => {
      expect(await uncoveredTools(spec)).toEqual([]);
      const actual = await captureGoldens(spec);
      if (updating) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const directory = new URL(`./goldens/${spec.provider}/`, import.meta.url);
        await mkdir(directory, { recursive: true });
        for (const file of GOLDEN_FILES) await writeFile(new URL(`${file}.json`, directory), actual[file]);
        return;
      }
      for (const file of GOLDEN_FILES) {
        const golden = stored[`./goldens/${spec.provider}/${file}.json`];
        expect(golden, `test/goldens/${spec.provider}/${file}.json is missing; run pnpm run goldens:update`).toBeTypeOf(
          "string",
        );
        expect(actual[file], `test/goldens/${spec.provider}/${file}.json`).toBe(golden);
      }
    }, 60_000);
  }
});
