// Existing characterization goldens: provider catalogs, the
// requests and results of its fixture calls, its failure mapping, and its
// sent-secret redaction, compared byte for byte with
// test/goldens/<provider>/*.json. `pnpm run goldens:update`
// rewrites them; this suite only compares. See the contributor section of
// documentation/architecture.md.
import { describe, expect, it } from "vitest";
import { canonicalGolden } from "./goldens/canonical.js";
import { captureGoldens, goldenFiles, uncoveredTools, type GoldenSpec } from "./goldens/harness.js";

// Vite's transform; the repository does not load vite/client types.
declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options?: { import?: string; query?: string; eager?: boolean }): Record<string, T>;
  }
}

const specs = import.meta.glob<GoldenSpec>("./goldens/*/spec.ts", { import: "default", eager: true });
const stored = import.meta.glob<string>("./goldens/*/*.json", { query: "?raw", import: "default", eager: true });

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const updating = env.CONNECTA_GOLDENS_UPDATE === "1";
const workerd = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
const determinism = env.CONNECTA_GOLDENS_DETERMINISM === "1";
const orders = updating || !workerd ? "both" : "canonical";
const only = env.CONNECTA_GOLDENS_ONLY?.split(",").filter(Boolean);

const byProvider = Object.values(specs)
  .filter((spec) => !only || only.includes(spec.provider))
  .sort((a, b) => a.provider.localeCompare(b.provider));

describe("characterization goldens", () => {
  it.skipIf(only)("keep existing fixtures consistent with their specs", () => {
    for (const [path, spec] of Object.entries(specs)) expect(path).toBe(`./goldens/${spec.provider}/spec.ts`);
    // No golden outlives its spec, and no folder holds a file the harness does not write.
    const expected = Object.values(specs).flatMap((spec) =>
      goldenFiles(spec).map((file) => `./goldens/${spec.provider}/${file}.json`),
    );
    expect(Object.keys(stored).sort()).toEqual(expected.sort());
  });

  for (const spec of byProvider) {
    it(
      `INV-5: ${spec.provider} catalog, fixture calls, failure mapping, and secret echoes match the goldens`,
      async () => {
        expect(await uncoveredTools(spec)).toEqual([]);
        // Nightly adds an identical repeat and two jittered captures; PRs capture once.
        for (const jitter of determinism && !updating ? [undefined, undefined, 1, 2] : [undefined]) {
          const actual = await captureGoldens(spec, { orders, ...(jitter === undefined ? {} : { jitter }) });
          if (updating) {
            const { mkdir, writeFile } = await import("node:fs/promises");
            const directory = new URL(`./goldens/${spec.provider}/`, import.meta.url);
            await mkdir(directory, { recursive: true });
            for (const file of goldenFiles(spec)) await writeFile(new URL(`${file}.json`, directory), actual[file]!);
            return;
          }
          for (const file of goldenFiles(spec)) {
            const golden = stored[`./goldens/${spec.provider}/${file}.json`];
            expect(
              golden,
              `test/goldens/${spec.provider}/${file}.json is missing; run pnpm run goldens:update`,
            ).toBeTypeOf("string");
            expect(actual[file], `test/goldens/${spec.provider}/${file}.json (jitter ${jitter ?? "none"})`).toBe(
              orders === "both" ? golden : canonicalGolden(golden!, file),
            );
          }
        }
      },
      determinism ? 120_000 : 60_000,
    );
  }
});
