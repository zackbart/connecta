// Compress retained proof bundles with the running Node's bundled zlib.
// Can run in cached official node:22-slim with a read-only mount, no network.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const directory = resolve(process.argv[2]);
const rows = [];
for (const name of [
  "root-baseline",
  "root-candidate",
  "worker-baseline",
  "worker-candidate",
  "root-effect-mcp-incremental",
  "worker-effect-mcp-incremental",
]) {
  const bytes = await readFile(join(directory, `${name}.mjs`));
  rows.push({ name, raw: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength });
}
console.log(JSON.stringify({ node: process.version, zlib: process.versions.zlib, rows }, null, 2));
