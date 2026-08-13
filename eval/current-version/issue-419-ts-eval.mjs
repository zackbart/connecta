import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import tsBlankSpace from "ts-blank-space";
import { transform as sucraseTransform } from "sucrase";
import ts from "typescript";
import { fixtures } from "./issue-419-fixtures.mjs";
import { normalizeCode } from "../../dist/executors/quickjs-runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const iterations = 10_000;

function unwrapFence(code) {
  const trimmed = code.trim();
  const match = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

const candidates = {
  "ts-blank-space": (code) => {
    const source = unwrapFence(code);
    const parsed = ts.createSourceFile("guest.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const diagnostic = parsed.parseDiagnostics[0];
    if (diagnostic) throw new SyntaxError(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    return tsBlankSpace(source, (node) => {
      throw new SyntaxError(`Unsupported TypeScript syntax: ${ts.SyntaxKind[node.kind]}`);
    });
  },
  sucrase: (code) => sucraseTransform(unwrapFence(code), { transforms: ["typescript"] }).code,
  typescript: (code) => ts.transpileModule(unwrapFence(code), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  }).outputText,
};

async function run(code) {
  const normalized = normalizeCode(code);
  const fn = Function(`"use strict"; return (${normalized});`)();
  return await fn();
}

async function evaluateFixture(fixture, transform) {
  try {
    const output = transform ? transform(fixture.code) : fixture.code;
    const result = await run(output);
    return {
      status: "ran",
      result,
      outputBytes: Buffer.byteLength(output),
      byteDelta: Buffer.byteLength(output) - Buffer.byteLength(unwrapFence(fixture.code)),
      sameLength: output.length === unwrapFence(fixture.code).length,
      sameLineCount: output.split("\n").length === unwrapFence(fixture.code).split("\n").length,
      returnOffsetPreserved:
        output.indexOf("return") === unwrapFence(fixture.code).indexOf("return"),
    };
  } catch (error) {
    return { status: "rejected", error: `${error.name}: ${error.message}`.split("\n")[0] };
  }
}

function percentile(values, p) {
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

async function benchmark(code, transform) {
  for (let index = 0; index < 100; index += 1) transform(code);
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    transform(code);
    samples.push((performance.now() - start) * 1_000);
  }
  samples.sort((a, b) => a - b);
  return { medianUs: percentile(samples, 0.5), p95Us: percentile(samples, 0.95) };
}

async function coldRun(code, transform) {
  const samples = [];
  for (let index = 0; index < 1_000; index += 1) {
    const start = performance.now();
    await run(transform(code));
    samples.push((performance.now() - start) * 1_000);
  }
  samples.sort((a, b) => a - b);
  return { medianUs: percentile(samples, 0.5), p95Us: percentile(samples, 0.95) };
}

async function directoryBytes(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    total += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
  }
  return total;
}

async function packageMetrics(name) {
  const pkg = JSON.parse(await readFile(resolve(here, "node_modules", name, "package.json"), "utf8"));
  const direct = await directoryBytes(resolve(here, "node_modules", name));
  const seen = new Set();
  async function closure(packageName) {
    if (seen.has(packageName)) return 0;
    seen.add(packageName);
    const path = resolve(here, "node_modules", packageName);
    const manifest = JSON.parse(await readFile(resolve(path, "package.json"), "utf8"));
    let bytes = await directoryBytes(path);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) bytes += await closure(dependency);
    return bytes;
  }
  return {
    version: pkg.version,
    installedPackageBytes: direct,
    installedDependencyClosureBytes: await closure(name),
    dependencyClosure: [...seen],
  };
}

const arms = { javascript: undefined, ...candidates };
const behavior = {};
for (const [name, transform] of Object.entries(arms)) {
  behavior[name] = {};
  for (const fixture of fixtures) behavior[name][fixture.id] = await evaluateFixture(fixture, transform);
}

assert.equal(behavior.javascript["valid-js"].result, 42);
for (const fixture of fixtures.filter((item) => item.group === "candidate")) {
  assert.equal(behavior["ts-blank-space"][fixture.id].result, fixture.expected, fixture.id);
}
for (const fixture of fixtures.filter((item) => item.group === "unsupported")) {
  assert.equal(behavior["ts-blank-space"][fixture.id].status, "rejected", fixture.id);
}
assert.equal(behavior["ts-blank-space"]["malformed-ts"].status, "rejected");

const representative = fixtures.find((item) => item.id === "erased-generic").code;
const latency = {};
for (const [name, transform] of Object.entries(candidates)) {
  latency[name] = {
    transform: await benchmark(representative, transform),
    normalizeAndExecute: await coldRun(representative, transform),
  };
}
latency.javascript = { normalizeAndExecute: await coldRun(fixtures[0].code, (value) => value) };

const packages = {};
for (const name of Object.keys(candidates)) packages[name] = await packageMetrics(name);
const report = {
  measuredAt: new Date().toISOString(),
  runtime: `${process.version} ${process.platform}-${process.arch}`,
  iterations,
  behavior,
  latency,
  packages,
};

if (!process.argv.includes("--verify")) {
  await writeFile(resolve(here, "results/issue-419-measurements.json"), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`issue #419 evaluation passed: ${fixtures.length} fixtures, ${iterations} transform samples per candidate`);
