// Contributor measurement, never imported by a deployment. Run with pnpm exec tsx.
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { normalizeDiscovery } from "./google-discovery.mjs";
import { buildOperationIndex, renderOpenApiModule, sha256 } from "./generate-openapi.mjs";

const start = performance.now();
const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.ts");
const importMs = performance.now() - start;
const pins = JSON.parse(await readFile(new URL("../test/fixtures/google-discovery/manifest.json", import.meta.url)));
const options = {
  depth: 5,
  numericBounds: true,
  formats: true,
  maxEnum: 200,
  requestGraph: true,
  deprecations: true,
  allSuccessResponses: true,
};
const measurements = [];
const indexes = [];
for (const pin of pins) {
  const bytes = await readFile(
    new URL(`../src/providers/${pin.provider}/evidence/discovery.document.json`, import.meta.url),
  );
  if (sha256(bytes) !== pin.digest) throw new Error(`Changed frozen ${pin.provider} bytes`);
  const document = normalizeDiscovery(JSON.parse(bytes));
  const source = { ...pin, options };
  const data = buildOperationIndex(document, source);
  indexes.push(data);
  const module = renderOpenApiModule(
    data,
    source,
    "evidence/openapi.json",
    sha256(JSON.stringify(document, null, 2) + "\n"),
  );
  const heap = process.memoryUsage().heapUsed;
  const factoryStart = performance.now();
  const index = new OperationIndex(data, { vendor: pin.provider, title: pin.provider, pathMatching: "uri-template" });
  const factoryMs = performance.now() - factoryStart;
  const searchStart = performance.now();
  index.search("list", { limit: 8, partial: true });
  const firstSearchMs = performance.now() - searchStart;
  // Exercise lazy request graph parsing, without counting it as search cost.
  const detailsStart = performance.now();
  for (const op of index.ops) index.contract(op);
  measurements.push({
    provider: pin.provider,
    operations: data.ops.length,
    sourceDigest: pin.digest,
    normalizedDigest: sha256(JSON.stringify(document, null, 2) + "\n"),
    indexBytes: Buffer.byteLength(module),
    indexGzip9: gzipSync(module, { level: 9 }).length,
    factoryMs,
    firstSearchMs,
    allDetailsMs: performance.now() - detailsStart,
    heapDeltaBytes: process.memoryUsage().heapUsed - heap,
  });
}
const root = fileURLToPath(new URL("../", import.meta.url));
const base = process.argv[2] ? resolve(process.argv[2]) : undefined;
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
const bundle = async (directory, product, withIndexes = false) => {
  const products = product ? [product] : pins.map((pin) => pin.provider);
  const contents =
    products
      .map((name) => `export {${name}} from ${JSON.stringify(resolve(directory, `src/providers/${name}/index.ts`))};`)
      .join("\n") +
    (withIndexes
      ? `\nexport const indexes=${JSON.stringify(indexes)};\nexport {googleHatchBinding} from ${JSON.stringify(resolve(directory, "src/providers/_shared/google/hatch.ts"))};`
      : "");
  const built = await build({
    stdin: { contents, resolveDir: directory, loader: "js" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser", "import"],
    mainFields: ["module", "main"],
    minify: true,
    write: false,
    logLevel: "silent",
    external: [...Object.keys(manifest.peerDependencies ?? {}), "cloudflare:*", "node:*"],
  });
  const bytes = built.outputFiles[0].contents;
  return { bytes: bytes.byteLength, gzip9: gzipSync(bytes, { level: 9 }).byteLength };
};
const bundles = [];
for (const product of pins.map((pin) => pin.provider))
  bundles.push({ product, before: base ? await bundle(base, product) : null, after: await bundle(root, product) });
bundles.push({
  product: "all-six",
  before: base ? await bundle(base) : null,
  after: await bundle(root),
  syntheticWithIndexes: await bundle(root, undefined, true),
});
console.log(JSON.stringify({ node: process.version, options, importMs, measurements, bundles }, null, 2));
