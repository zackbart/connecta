// Node-only: builds and imports a genuine minified production graph with esbuild.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("INV-4 INV-7 INV-9 INV-13: production minification preserves upward native identity, fresh protocol leaves and request ownership", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const result = await build({
    absWorkingDir: root,
    entryPoints: [fileURLToPath(new URL("./fixtures/upward-native-bundle.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser", "import"],
    mainFields: ["module", "main"],
    minify: true,
    metafile: true,
    write: false,
    outfile: "upward-native-smoke.mjs",
    logLevel: "silent",
    external: [...Object.keys(manifest.peerDependencies), "cloudflare:*", "node:*"],
  });
  const output = result.outputFiles.find((file) => file.path.endsWith(".mjs"))!;
  const artifact = process.env.CONNECTA_UPWARD_BUNDLE_EVIDENCE;
  if (artifact) {
    await writeFile(`${artifact}.mjs`, output.contents);
    await writeFile(`${artifact}.metafile.json`, JSON.stringify(result.metafile, null, 2));
  }
  const module = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
  );
  const report = await module.runUpwardBundleSmoke().catch((error: unknown) => {
    throw new Error(String(error));
  });
  expect(report).toMatchObject({
    modern: { answered: "read" },
    legacy: { answered: "write" },
    nativePromiseListings: 0,
    promiseListings: 1,
    decoratedListings: 1,
    writes: 1,
    requestOwners: 4,
    allOwnersClosed: true,
  });
  expect(report.nativeListings).toBe(4);
  if (artifact)
    await writeFile(
      `${artifact}.json`,
      JSON.stringify(
        { sha256: createHash("sha256").update(output.contents).digest("hex"), bytes: output.contents.length, report },
        null,
        2,
      ) + "\n",
    );
});
