// Production-only experiment for #573. Deploys a disposable Worker, uses only
// synthetic data, saves observations, and deletes the Worker in finally.
// Usage: node scripts/probes/worker-disconnect.mjs [output.json]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wrangler = join(root, "node_modules/.bin/wrangler");
const output = resolve(process.argv[2] ?? join(root, "eval/results/worker-disconnect.json"));
const temp = await mkdtemp(join(tmpdir(), "connecta-disconnect-"));
const name = `connecta-disconnect-${Date.now().toString(36)}`;
const key = randomBytes(24).toString("hex");
const configPath = join(temp, "wrangler.json");
const observations = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let deploymentAttempted = false;

const source = `
import { createConnecta } from ${JSON.stringify(join(root, "src/index.ts"))};
let isolate;
const events = [];
const apps = new Map();
const enc = new TextEncoder();
function event(id, kind) { events.push({ id, kind, at: Date.now() }); }
function stream(request, id, mode) {
  request.signal.addEventListener('abort', () => event(id, 'abort'), { once: true });
  let timer;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('started ' + id + '\\n'));
      // A bounded live timer is also a control against the hung-request path.
      if (mode === 'heartbeat') timer = setInterval(() => {
        event(id, 'tick');
        try { controller.enqueue(enc.encode('tick\\n')); } catch { clearInterval(timer); }
      }, 250);
      if (mode === 'idle-timer') timer = setTimeout(() => event(id, 'deadline'), 5000);
    },
    cancel() { event(id, 'cancel'); clearInterval(timer); }
  });
}
export default {
  async fetch(request, env) {
    if (request.headers.get('authorization') !== 'Bearer ' + env.PROBE_KEY) return new Response(null, { status: 404 });
    isolate ??= crypto.randomUUID();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    let app = apps.get(id);
    if (!app) { app = createConnecta({
      connectors: [], logger: 'silent', executor: { execute: async () => ({ result: null }) },
      admission: { requests: { concurrency: 1, maxQueueSize: 0, queueTimeoutMs: 1000 } },
      auth: { kind: 'probe', authorize(req) {
        if (req.headers.get('x-probe-pass') === 'yes') return { ok: true };
        const u = new URL(req.url);
        const id = u.searchParams.get('id');
        event(id, 'admitted');
        return { ok: false, response: new Response(stream(req, id, u.searchParams.get('mode')), { status: 401 }) };
      } }
    }); apps.set(id, app); }
    if (url.pathname === '/stats') {
      const health = await app.fetch(new Request(url.origin + '/health'));
      return Response.json({ isolate, version: env.PROBE_VERSION, events, health: await health.json() });
    }
    event(id, 'start');
    let response;
    if (url.pathname === '/raw') response = new Response(stream(request, id, url.searchParams.get('mode')));
    else response = await app.fetch(request);
    response.headers.set('x-probe-isolate', isolate);
    response.headers.set('x-probe-version', env.PROBE_VERSION);
    response.headers.set('cache-control', 'no-store');
    return response;
  }
};
`;

try {
  await writeFile(join(temp, "worker.mjs"), source);
  for (const enabled of [false, true]) {
    const flags = enabled ? ["enable_request_signal"] : [];
    await writeFile(configPath, JSON.stringify({ name, main: "worker.mjs",
      compatibility_date: "2025-01-01", compatibility_flags: flags,
      workers_dev: true, vars: { PROBE_KEY: key, PROBE_VERSION: String(enabled) }, observability: { enabled: false },
    }), { mode: 0o600 });
    // A failed CLI response does not prove the remote deployment failed.
    deploymentAttempted = true;
    const deployment = await exec(wrangler, ["deploy", "--config", configPath], { cwd: root, maxBuffer: 2 ** 20 });
    const origin = deployment.stdout.match(new RegExp(`https://${name}\\.[a-zA-Z0-9-]+\\.workers\\.dev`))?.[0];
    if (!origin) throw new Error("Deployment returned no workers.dev URL");
    console.log(`Deployed ${origin}, request signal ${enabled ? 'enabled' : 'default'}`);
    for (let attempt = 0; attempt < 30; attempt++) {
      const ready = await fetch(`${origin}/stats`, { headers: { authorization: `Bearer ${key}` } });
      if (ready.headers.get('content-type')?.includes('application/json') &&
          (await ready.json()).version === String(enabled)) break;
      if (attempt === 29) throw new Error(`Worker route never became ready: ${ready.status}`);
      if (!ready.bodyUsed) await ready.body?.cancel();
      await wait(2000);
    }
    for (const route of ["raw", "mcp"]) {
      for (const mode of ["heartbeat", "idle-timer", "stalled"]) {
        const id = `${route}-${mode}-${enabled}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const headers = { authorization: `Bearer ${key}` };
        const response = await fetch(`${origin}/${route}?id=${id}&mode=${mode}`, { headers, signal: controller.signal });
        const isolate = response.headers.get("x-probe-isolate");
        const reader = response.body.getReader();
        let first;
        try { first = await reader.read(); } catch (error) { first = { error: String(error) }; }
        let clientEnd;
        const drained = (async () => {
          try { while (!(await reader.read()).done) {} clientEnd = { kind: 'end' }; }
          catch (error) { clientEnd = { kind: 'error', message: String(error) }; }
        })();
        await wait(750);
        const clientEndedBeforeAbort = clientEnd ?? null;
        controller.abort();
        clearTimeout(timeout);
        try { await reader.cancel(); } catch {}
        await drained;
        await wait(1500);
        const snapshots = [];
        for (let attempt = 0; attempt < 4; attempt++) {
          const statsResponse = await fetch(`${origin}/stats?id=${id}`, { headers });
          const statsText = await statsResponse.text();
          let stats;
          try { stats = JSON.parse(statsText); }
          catch { throw new Error(`Stats failed: ${statsResponse.status} ${statsText.slice(0, 1500)}`); }
          snapshots.push(stats);
          if (stats.isolate === isolate) break;
          await wait(100);
        }
        const same = snapshots.find(s => s.isolate === isolate);
        const followup = await fetch(`${origin}/mcp?id=${id}`, { method: "POST", headers: {
          ...headers, "x-probe-pass": "yes", "content-type": "application/json",
          accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26",
        }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
        const followupBody = await followup.text();
        const observation = { enabled, servedVersion: response.headers.get('x-probe-version'),
          compatibilityDate: "2025-01-01", flags, route, mode, id, isolate,
          status: response.status, first: first?.value ? new TextDecoder().decode(first.value) : first,
          clientEndedBeforeAbort,
          sameIsolate: Boolean(same), events: same?.events.filter(e => e.id === id),
          admission: same?.health.admission.requests,
          followup: { status: followup.status, sameIsolate: followup.headers.get("x-probe-isolate") === isolate,
            body: followupBody.slice(0, 300) },
        };
        observations.push(observation);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify({ testedAt: new Date().toISOString(), name, observations }, null, 2));
        console.log(JSON.stringify(observation));
      }
    }
  }
} finally {
  try {
    if (deploymentAttempted) {
      await exec(wrangler, ["delete", "--config", configPath, "--force"], { cwd: root });
      console.log(`Deleted ${name}`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
