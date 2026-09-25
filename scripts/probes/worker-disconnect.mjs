// Production-only regression probe for #573/#595. Deploys a disposable Worker, uses only
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
const maxDurationMs = 2000;
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
    const requestStartedAt = Date.now();
    if (request.headers.get('authorization') !== 'Bearer ' + env.PROBE_KEY) return new Response(null, { status: 404 });
    isolate ??= crypto.randomUUID();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    let app = apps.get(id);
    if (!app) { app = createConnecta({
      connectors: [], logger: 'silent', executor: { execute: async () => ({ result: null }) },
      admission: { requests: { concurrency: 1, maxQueueSize: url.searchParams.has('queue') ? 1 : 0,
        queueTimeoutMs: url.searchParams.has('queue') ? 6000 : 1000,
        maxDurationMs: ${maxDurationMs} } },
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
    response.headers.set('x-probe-started-at', String(requestStartedAt));
    response.headers.set('x-probe-finished-at', String(Date.now()));
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
      for (const mode of ["heartbeat", "idle-timer", "stalled", ...(route === 'mcp' ? ['queued-handoff'] : [])]) {
        const id = `${route}-${mode}-${enabled}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const headers = { authorization: `Bearer ${key}` };
        const listTools = (signal) => fetch(`${origin}/mcp?id=${id}`, { method: "POST", signal, headers: {
          ...headers, "x-probe-pass": "yes", "content-type": "application/json",
          accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26",
        }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
        const suffix = mode === 'queued-handoff' ? 'mode=heartbeat&queue=1' : `mode=${mode}`;
        const response = await fetch(`${origin}/${route}?id=${id}&${suffix}`, { headers, signal: controller.signal });
        const responseAt = Date.now();
        const isolate = response.headers.get("x-probe-isolate");
        const reader = response.body.getReader();
        let first;
        try { first = await reader.read(); } catch (error) { first = { error: String(error) }; }
        let clientEnd;
        const drained = (async () => {
          try { while (!(await reader.read()).done) {} clientEnd = { kind: 'end' }; }
          catch (error) { clientEnd = { kind: 'error', message: String(error) }; }
        })();
        let whileLive;
        let abandonedQueue;
        if (mode === 'queued-handoff') {
          const orphanAbort = new AbortController();
          let orphanOutcome;
          const orphan = listTools(orphanAbort.signal).then(r => {
            orphanOutcome = { kind: 'response', status: r.status };
            return r.body?.cancel();
          }).catch(error => {
            orphanOutcome ??= { kind: orphanAbort.signal.aborted ? 'client-abort' : 'error', message: String(error) };
          });
          try {
            for (let attempt = 0; attempt < 10; attempt++) {
              const before = await fetch(`${origin}/stats?id=${id}`, { headers }).then(r => r.json());
              abandonedQueue = { sameIsolate: before.isolate === isolate,
                queued: before.health.admission.requests.queued, elapsedMs: Date.now() - responseAt };
              if (abandonedQueue.sameIsolate && abandonedQueue.queued === 1) break;
              await wait(20);
            }
          } finally {
            orphanAbort.abort();
            await orphan;
          }
          await wait(50);
          const after = await fetch(`${origin}/stats?id=${id}`, { headers }).then(r => r.json());
          abandonedQueue.orphanOutcome = orphanOutcome;
          abandonedQueue.afterAbort = { sameIsolate: after.isolate === isolate,
            queued: after.health.admission.requests.queued, elapsedMs: Date.now() - responseAt };
          abandonedQueue.scenario = abandonedQueue.afterAbort.queued === 1
            ? 'orphan-retained' : 'queue-cancellation-control';
        } else if (route === 'mcp') {
          const clientEndBeforeCheck = clientEnd ?? null;
          const competing = await listTools();
          whileLive = { status: competing.status,
            clientEndBeforeCheck,
            sameIsolate: competing.headers.get('x-probe-isolate') === isolate,
            // Compare two server timestamps. The original lease can only be
            // granted after its Worker entry, and the competing decision ran
            // before its response returned. This is a conservative bound.
            elapsedMs: Number(competing.headers.get('x-probe-finished-at') ?? NaN) -
              Number(response.headers.get('x-probe-started-at') ?? NaN) };
          const competingBody = await competing.text();
          try { whileLive.toolCount = JSON.parse(competingBody).result?.tools?.length; } catch {}
          whileLive.clientEndAtCheck = clientEnd ?? null;
        }
        await wait(750);
        const clientEndedBeforeAbort = clientEnd ?? null;
        controller.abort();
        clearTimeout(timeout);
        try { await reader.cancel(); } catch {}
        await drained;
        // Do not read /health after expiry before this request. Admission must
        // recover from acquire itself, without a monitoring request sweeping it.
        await wait(Math.max(0, maxDurationMs + 500 - (Date.now() - responseAt)));
        const followupStartedAt = Date.now();
        const followup = await listTools(AbortSignal.timeout(10000));
        const followupBody = await followup.text();
        let toolCount;
        try { toolCount = JSON.parse(followupBody).result?.tools?.length; } catch {}
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
        const observation = { enabled, servedVersion: response.headers.get('x-probe-version'),
          compatibilityDate: "2025-01-01", flags, maxDurationMs, route, mode, id, isolate,
          status: response.status, first: first?.value ? new TextDecoder().decode(first.value) : first,
          clientEndedBeforeAbort, whileLive, abandonedQueue,
          sameIsolate: Boolean(same), events: same?.events.filter(e => e.id === id),
          admission: same?.health.admission.requests,
          followup: { status: followup.status, sameIsolate: followup.headers.get("x-probe-isolate") === isolate,
            toolCount, elapsedMs: Date.now() - followupStartedAt, body: followupBody.slice(0, 300) },
        };
        observation.passed = observation.servedVersion === String(enabled) &&
          response.status === (route === 'mcp' ? 401 : 200) && observation.sameIsolate &&
          observation.admission.active === 0 && observation.followup.status === 200 &&
          observation.followup.sameIsolate && toolCount === 8 &&
          (!abandonedQueue || (abandonedQueue.sameIsolate && abandonedQueue.queued === 1 &&
            abandonedQueue.elapsedMs < maxDurationMs && abandonedQueue.afterAbort.sameIsolate &&
            abandonedQueue.afterAbort.elapsedMs < maxDurationMs && abandonedQueue.orphanOutcome.kind === 'client-abort' &&
            (enabled || abandonedQueue.afterAbort.queued === 1) && observation.followup.elapsedMs < maxDurationMs + 1000)) &&
          (!whileLive || (whileLive.sameIsolate && whileLive.elapsedMs >= 0 && whileLive.elapsedMs < maxDurationMs &&
            (whileLive.status === 503 || (whileLive.clientEndBeforeCheck && whileLive.status === 200 && whileLive.toolCount === 8))));
        observation.verdict = whileLive && (!Number.isFinite(whileLive.elapsedMs) || whileLive.elapsedMs < 0 || whileLive.elapsedMs >= maxDurationMs)
          ? 'inconclusive: contention arrived after the conservative deadline'
          : whileLive?.status === 200 && !whileLive.clientEndBeforeCheck && whileLive.clientEndAtCheck
          ? 'inconclusive: original stream ended during contention'
          : abandonedQueue && (!abandonedQueue.sameIsolate || !abandonedQueue.afterAbort.sameIsolate ||
            abandonedQueue.elapsedMs >= maxDurationMs || abandonedQueue.afterAbort.elapsedMs >= maxDurationMs)
          ? 'inconclusive: queue evidence missed the original isolate or pre-expiry window'
          : abandonedQueue && (abandonedQueue.orphanOutcome.kind !== 'client-abort' ||
            (!enabled && abandonedQueue.afterAbort.queued !== 1))
          ? 'inconclusive: abandoned queue was not reproduced'
          : observation.passed ? 'pass' : 'fail';
        observations.push(observation);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify({ testedAt: new Date().toISOString(), name, observations }, null, 2));
        console.log(JSON.stringify(observation));
      }
    }
  }
  if (observations.some(row => !row.passed)) throw new Error(`Disconnect regression not verified; see ${output}`);
} finally {
  try {
    if (deploymentAttempted) {
      let deletionError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await exec(wrangler, ["delete", "--config", configPath, "--force"], { cwd: root });
          deletionError = undefined;
          break;
        } catch (error) {
          deletionError = error;
          if (attempt < 2) await wait(500);
        }
      }
      if (deletionError) throw new Error(
        `Could not delete disposable Worker ${name}. Run wrangler delete ${name} --force.`,
        { cause: deletionError },
      );
      console.log(`Deleted ${name}`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
