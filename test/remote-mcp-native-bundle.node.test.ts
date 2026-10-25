// Node-only: runs esbuild's binary and loads the resulting production bundle.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("INV-7 INV-13: production minification preserves native remote entry, cache registration and decorated fallback", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const result = await build({
    absWorkingDir: root,
    entryPoints: [fileURLToPath(new URL("./fixtures/remote-native-bundle.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser", "import"],
    mainFields: ["module", "main"],
    minify: true,
    metafile: true,
    write: false,
    outfile: "remote-native-smoke.mjs",
    logLevel: "silent",
    external: [...Object.keys(manifest.peerDependencies), "cloudflare:*", "node:*"],
  });
  const output = result.outputFiles.find((file) => file.path.endsWith(".mjs"))!;
  const sha256 = createHash("sha256").update(output.contents).digest("hex");
  const artifact = process.env.CONNECTA_REMOTE_BUNDLE_EVIDENCE;
  if (artifact) {
    await writeFile(`${artifact}.mjs`, output.contents);
    await writeFile(`${artifact}.metafile.json`, JSON.stringify(result.metafile, null, 2));
  }
  const module = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
  );
  const report = await module.runRemoteBundleSmoke();
  expect(report).toMatchObject({
    registered: true,
    canonicalRequestScope: true,
    promiseStorageCalls: 0,
    calls: 3,
    decorators: 2,
    customResult: "custom",
    closedOwnerRefused: true,
  });
  expect(report.nativeStorageReads).toBeGreaterThan(0);
  expect(Object.keys(result.metafile.inputs)).toEqual(
    expect.arrayContaining([
      "src/connectors/remote-mcp.ts",
      "src/catalog-cache.ts",
      "src/connectors/negotiation-cache.ts",
      "src/runtime/call-entry.ts",
    ]),
  );
  if (artifact)
    await writeFile(
      `${artifact}.json`,
      JSON.stringify({ sha256, bytes: output.contents.length, report }, null, 2) + "\n",
    );
});
