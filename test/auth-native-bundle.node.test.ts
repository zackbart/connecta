// Node-only: runs esbuild's binary and loads the resulting production bundle.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("INV-7 INV-13: production minification preserves native auth registration, Context/storage and decorated fallback", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const result = await build({
    absWorkingDir: root,
    entryPoints: [fileURLToPath(new URL("./fixtures/auth-native-bundle.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser", "import"],
    mainFields: ["module", "main"],
    minify: true,
    metafile: true,
    write: false,
    outfile: "auth-native-smoke.mjs",
    logLevel: "silent",
    external: [...Object.keys(manifest.peerDependencies), "cloudflare:*", "node:*"],
  });
  const output = result.outputFiles.find((file) => file.path.endsWith(".mjs"))!;
  const sha256 = createHash("sha256").update(output.contents).digest("hex");
  const artifact = process.env.CONNECTA_AUTH_BUNDLE_EVIDENCE;
  if (artifact) {
    await writeFile(`${artifact}.mjs`, output.contents);
    await writeFile(`${artifact}.metafile.json`, JSON.stringify(result.metafile, null, 2));
  }
  const module = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
  );
  const report = await module.runAuthBundleSmoke();
  expect(report).toMatchObject({
    topLevelRegistration: true,
    canonicalRequestScope: true,
    promiseStorageCalls: 0,
    fetches: 1,
    closedOwnerRefused: true,
    decorators: ["instance", "prototype", "inherited"],
    customCalls: 1,
  });
  expect(report.nativeStorageReads).toBeGreaterThan(0);
  expect(Object.keys(result.metafile.inputs)).toEqual(
    expect.arrayContaining([
      "src/auth/native.ts",
      "src/auth/native-call.ts",
      "src/auth/downstream-oauth.ts",
      "src/auth-admission.ts",
    ]),
  );
  if (artifact)
    await writeFile(
      `${artifact}.json`,
      JSON.stringify({ sha256, bytes: output.contents.length, report }, null, 2) + "\n",
    );
});
