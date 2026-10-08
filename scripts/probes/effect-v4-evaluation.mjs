// Local evaluation of Effect 4.0.0's MCP, Schema, and HTTP replacements.
// Synthetic requests only. Never deploys or contacts a provider.
// Run npm run build, then node scripts/probes/effect-v4-evaluation.mjs output.json.
// Bundle figures are incremental probes alongside existing implementations,
// not measurements of complete replacements or of removed dependency savings.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = await mkdtemp(join(tmpdir(), "connecta-effect-evaluation-"));
const prototypes = {
  mcp: `import { Effect, Layer, Context } from 'effect';
import { McpServer, McpProtocol, McpSchema } from 'effect/ai';
import { HttpRouter } from 'effect/http';

const registration = Layer.effectDiscard(Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  yield* server.addTool({
    tool: new McpSchema.Tool({ name: 'probe', description: 'Synthetic read', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }),
    annotations: Context.empty(),
    handle: () => Effect.succeed(new McpSchema.CallToolResult({ content: [{ type: 'text', text: 'ok' }] })),
  });
}));
export function makeServer(protocols = [McpProtocol.v2025_06_18, McpProtocol.v2026_07_28]) {
  const server = McpServer.layerHttp({ name: 'probe', version: '1', path: '/mcp', protocols });
  return HttpRouter.toWebHandler(registration.pipe(Layer.provideMerge(server)), { disableLogger: true });
}
`,
  schema: `import { Schema } from 'effect';
const optional = Schema.optionalKey;
const integer = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }));
const positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const call = Schema.Struct({
  address: Schema.String,
  args: optional(Schema.Record(Schema.String, Schema.Unknown)),
  resultMode: optional(Schema.Literals(['mcp', 'value'])),
  timeoutMs: optional(positive),
  diagnostics: optional(Schema.Boolean),
});
export const search = Schema.Struct({
  query: optional(Schema.String), connector: optional(Schema.String),
  safety: optional(Schema.Literals(['readOnly', 'approvalRequired', 'all'])),
  limit: optional(positive.check(Schema.isLessThanOrEqualTo(100))),
  offset: optional(integer.check(Schema.isGreaterThanOrEqualTo(0))),
  fullDescriptions: optional(Schema.Boolean),
  includeSchemas: optional(Schema.Literals(['compact', 'json', 'typescript'])),
});
export const rendered = [Schema.toJsonSchemaDocument(call, { onExcessProperty: 'error' }), Schema.toJsonSchemaDocument(search)];
export const validate = Schema.decodeUnknownSync(call, { onExcessProperty: 'error' });
`,
  router: `import { Effect } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
export function makeRouter() {
  return HttpRouter.toWebHandler(HttpRouter.add('GET', '/ui/data', Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }))), { disableLogger: true });
}
`,
  httpapi: `import { Effect, Layer, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiGroup, HttpApiEndpoint, HttpApiBuilder } from 'effect/http-api';
const api = HttpApi.make('probe').add(HttpApiGroup.make('operator').add(HttpApiEndpoint.get('data', '/ui/data', { success: Schema.Struct({ ok: Schema.Boolean }) })));
const handlers = HttpApiBuilder.group(api, 'operator', h => h.handle('data', () => Effect.succeed({ ok: true })));
export function makeApi() {
  return HttpRouter.toWebHandler(HttpApiBuilder.layer(api).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)), { disableLogger: true });
}
`,
};
const probeSource = `import { makeServer } from './mcp.mjs';
import { makeRouter } from './router.mjs';
import { makeApi } from './httpapi.mjs';
import { call, search, rendered, validate } from './schema.mjs';
import { createConnecta, customExecutor } from __CONNECTA_ENTRY__;
import { Schema } from 'effect';
import { writeFileSync } from 'node:fs';

const results = { mcp: [], http: [], schema: {} };
let id = 0;
function request(method, params = {}, headers = {}) {
  return new Request('https://probe.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
}
async function inspect(label, fetcher, req) {
  const response = await fetcher(req);
  const body = await response.text();
  const result = { label, status: response.status, contentType: response.headers.get('content-type'), session: response.headers.get('mcp-session-id'), body };
  results.mcp.push(result);
  return result;
}
const deployment = createConnecta({ connectors: [], executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }), logger: 'silent' });
const originalList = await inspect('connecta legacy fresh tools/list', req => deployment.fetch(req), request('tools/list'));
const original = JSON.parse(originalList.body).result.tools;
const first = makeServer();
const second = makeServer();
try {
  await inspect('effect legacy fresh tools/list', first.handler, request('tools/list'));
  const initialized = await inspect('effect legacy initialize', first.handler, request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }));
  if (initialized.session) {
    await inspect('effect legacy same handler tools/list', first.handler, request('tools/list', {}, { 'mcp-session-id': initialized.session }));
    await inspect('effect legacy fresh handler tools/list', second.handler, request('tools/list', {}, { 'mcp-session-id': initialized.session }));
  }
  await inspect('effect modern tools/list', second.handler, request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }));
} finally { await first.dispose(); await second.dispose(); }
for (const [label, make] of [['router', makeRouter], ['httpapi', makeApi]]) {
  const app = make();
  try {
    for (const [method, path] of [['GET', '/ui/data'], ['POST', '/ui/data'], ['GET', '/unowned']]) {
      const response = await app.handler(new Request('https://probe.test' + path, { method }));
      results.http.push({ label, method, path, status: response.status, contentType: response.headers.get('content-type'), body: await response.text() });
    }
  } finally { await app.dispose(); }
}
results.schema.originalCall = original.find(x => x.name === 'call_tool').inputSchema;
results.schema.originalSearch = original.find(x => x.name === 'search_tools').inputSchema;
results.schema.effectCall = rendered[0]; results.schema.effectSearch = rendered[1];
results.schema.validation = [{ address: 'probe', extra: true }, { address: 'probe', timeoutMs: Number.MAX_SAFE_INTEGER + 1 }, { address: 'probe', timeoutMs: 0 }, { address: 'probe', args: { nested: true } }].map(input => { try { return { input, value: validate(input), accepted: true }; } catch (error) { return { input, accepted: false, error: error.message }; } });
results.schema.defaultExcess = Schema.decodeUnknownSync(call)({ address: 'probe', extra: true });
await deployment.close();
writeFileSync('__EVALUATION_DIR__/results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify({ mcp: results.mcp.map(({body, ...x}) => ({ ...x, body: body.slice(0,300) })), http: results.http, schema: results.schema }, null, 2));
`;
const measureSource = `import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const root = __ROOT__;
const probes = __WORK__;
const results = [];
for (const [entry, file] of [['root', 'index'], ['ui', 'ui'], ['activity', 'activity']]) {
  let baseline;
  for (const probe of [null, 'schema', 'router', 'httpapi', 'mcp']) {
    const code = \`export * from '\${root}/src/\${file}.ts';\\n\${probe ? \`export * as probe from '\${probes}/\${probe}.mjs';\` : ''}\`;
    const built = await build({ stdin: { contents: code, resolveDir: root, sourcefile: 'evaluation.js', loader: 'js' }, bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser', 'import'], mainFields: ['module', 'main'], minify: true, write: false, metafile: true, external: ['@clerk/backend', '@cloudflare/codemode', 'quickjs-emscripten', 'cloudflare:*', 'node:*'], logLevel: 'silent' });
    const gzip = gzipSync(built.outputFiles[0].contents, { level: 9 }).length;
    if (probe === null) baseline = gzip;
    results.push({ entry, probe: probe ?? 'baseline', gzip, delta: gzip - baseline, nodeImports: Object.values(built.metafile.outputs).flatMap(x => x.imports.filter(i => i.external && i.path.startsWith('node:')).map(i => i.path)) });
  }
}
for (const probe of ['schema', 'router', 'httpapi', 'mcp']) {
  const built = await build({ entryPoints: [\`\${probes}/\${probe}.mjs\`], bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser', 'import'], mainFields: ['module', 'main'], minify: true, write: false, external: ['node:*'], logLevel: 'silent' });
  results.push({ entry: 'standalone', probe, gzip: gzipSync(built.outputFiles[0].contents, {level:9}).length });
}
writeFileSync(\`\${probes}/sizes.json\`, JSON.stringify(results,null,2));
console.table(results.map(({nodeImports,...r})=>r));
`;

try {
  await symlink(join(root, "node_modules"), join(work, "node_modules"), "dir");
  for (const [name, source] of Object.entries(prototypes)) {
    await writeFile(join(work, `${name}.mjs`), source);
  }
  await writeFile(
    join(work, "probe.mjs"),
    probeSource
      .replace("__CONNECTA_ENTRY__", JSON.stringify(pathToFileURL(join(root, "dist/index.js")).href))
      .replaceAll("__EVALUATION_DIR__", work),
  );
  await writeFile(
    join(work, "measure.mjs"),
    measureSource.replace("__ROOT__", JSON.stringify(root)).replace("__WORK__", JSON.stringify(work)),
  );
  execFileSync(process.execPath, [join(work, "probe.mjs")], { encoding: "utf8", timeout: 60_000 });
  execFileSync(process.execPath, [join(work, "measure.mjs")], { encoding: "utf8", timeout: 60_000 });
  const observations = JSON.parse(await readFile(join(work, "results.json"), "utf8"));
  // Session ids are synthetic and needed only between requests, not in the report.
  for (const row of observations.mcp) {
    if (row.session !== null) row.session = "synthetic-session-issued";
  }
  const sizes = JSON.parse(await readFile(join(work, "sizes.json"), "utf8"));
  const effect = JSON.parse(await readFile(join(root, "node_modules/effect/package.json"), "utf8")).version;
  const report = {
    measuredAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    node: process.version,
    effect,
    limitations: [
      "Node request probes, not workerd lifetime verification or live client interoperability.",
      "Synthetic MCP tool, two representative native input schemas, and one HTTP route.",
      "Incremental bundle costs alongside current code; full replacement savings are not measured.",
      "HttpRouter.toWebHandler uses its own runner; integration with Connecta's single runner is not proven.",
    ],
    observations,
    sizes,
  };
  const output = JSON.stringify(report, null, 2) + "\n";
  if (process.argv[2]) {
    await writeFile(resolve(process.argv[2]), output);
    console.log(`Saved evaluation to ${resolve(process.argv[2])}`);
  } else {
    console.log(output);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
