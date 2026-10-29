/**
 * Negative controls for the worker target (#1173 item 0.2): the vendor
 * gateway's credential and loopback refusal, the Worker-side redirect rules,
 * process-group cleanup after a launcher crash, the egress guard on wrangler's
 * own Node processes, and comparator provenance across targets.
 */
import { spawn, spawnSync } from "node:child_process";
import { createSocket as createDgramSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as connectNet, createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { playReference } from "../agent/reference.js";
import { gradeTask } from "./grading.js";
import { crossTarget, compare } from "../compare.js";
import { startVendorGateway } from "../deploy/worker.js";
import { GATEWAY_ERROR_HEADER, GATEWAY_TOKEN_HEADER, VENDOR_URL_HEADER, viaGateway } from "../deploy/gateway-fetch.js";
import { fakeTransportState, routeFakeVendor } from "../fakes/transport.js";
import type { AgentResultFile } from "../report/summary.js";
import { flags, ROOT, runProtocol } from "../support/meta.js";
import { evalConfig } from "../deploy/compose.js";
import { withD1Latency } from "../deploy/d1-latency.js";
import { isInjected, NO_INJECTION, parseInjection, type Injection } from "../fakes/injection.js";
import { World, type WorldOptions } from "../fakes/world.js";
import { serveFetch } from "../support/serve.js";
import { groupMembers, killAllProcesses, stopAllProcesses, WRANGLER_ENV, wranglerDev } from "../support/workerd.js";
import { ACTIVE_TASKS } from "./index.js";

function refused(action: () => unknown, message: string): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(message);
}

async function rejects(action: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (pattern.test(String(error instanceof Error ? error.message : error))) return;
    throw new Error(`${message}: ${String(error)}`);
  }
  throw new Error(message);
}

/** Only the trial's Worker may use the gateway, and never to reach a local service. */
export async function gatewayControls() {
  const seen: Headers[] = [];
  const local = await serveFetch(async (request) => {
    seen.push(request.headers);
    return new Response("local service");
  });
  const release = routeFakeVendor({
    hosts: ["api.stripe.com"],
    owns: (credential) => credential === "sk_test_gateway_control",
    target: local.url,
  });
  const gateway = await startVendorGateway();
  try {
    const send = (headers: Record<string, string>) => fetch(gateway.url, { headers, redirect: "manual" });
    for (const [label, headers] of [
      ["no credential", { [VENDOR_URL_HEADER]: `${local.url}/` }],
      ["a wrong credential", { [VENDOR_URL_HEADER]: `${local.url}/`, [GATEWAY_TOKEN_HEADER]: "guess" }],
    ] as const) {
      const response = await send(headers);
      if (response.status !== 403 || !response.headers.get(GATEWAY_ERROR_HEADER))
        throw new Error(`Gateway admitted a request with ${label}: HTTP ${response.status}`);
    }
    for (const target of [
      `${local.url}/`,
      local.url.replace("127.0.0.1", "localhost"),
      local.url.replace("127.0.0.1", "127.0.0.2"),
      local.url.replace("127.0.0.1", "[::1]"),
      local.url.replace("127.0.0.1", "[::ffff:127.0.0.1]"),
      "file:///etc/passwd",
    ]) {
      const response = await send({ [VENDOR_URL_HEADER]: target, [GATEWAY_TOKEN_HEADER]: gateway.token });
      if (response.status !== 403) throw new Error(`Gateway forwarded to ${target}: HTTP ${response.status}`);
    }
    const unknown = await send({ [VENDOR_URL_HEADER]: "https://example.com/", [GATEWAY_TOKEN_HEADER]: gateway.token });
    if (unknown.status !== 502 || !/Eval refused/.test(await unknown.text()))
      throw new Error("Gateway reached a host the fake transport does not own");
    if (seen.length) throw new Error("A refused gateway request reached the local service");
    const routed = await send({
      [VENDOR_URL_HEADER]: "https://api.stripe.com/v1/balance",
      [GATEWAY_TOKEN_HEADER]: gateway.token,
      Authorization: "Bearer sk_test_gateway_control",
    });
    if (routed.status !== 200 || seen.length !== 1) throw new Error("Gateway did not route an owned vendor credential");
    if (seen[0]!.has(GATEWAY_TOKEN_HEADER) || seen[0]!.has(VENDOR_URL_HEADER))
      throw new Error("Gateway forwarded its own credential or routing header");
  } finally {
    await gateway.close();
    release();
    await local.close();
  }
}

/** The Worker's wrapper follows redirects under the fake transport's rules. */
export async function gatewayRedirectControls() {
  const GATEWAY = "http://127.0.0.1:1/gateway";
  const calls: { url: string; method: string; headers: Headers; hasBody: boolean }[] = [];
  let script: (url: URL, hop: number) => Response = () => new Response("ok");
  const native = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const url = String(input) === GATEWAY ? new URL(headers.get(VENDOR_URL_HEADER)!) : new URL(String(input));
    calls.push({ url: String(input), method: init?.method ?? "GET", headers, hasBody: init?.body != null });
    if (init?.redirect !== "manual") throw new Error("Wrapper dispatched a hop without redirect: manual");
    return script(url, calls.length);
  }) as typeof fetch;
  const wrapped = viaGateway(native, GATEWAY, "trial-token");
  const sensitive = { Authorization: "Bearer sk_secret", Cookie: "session=1", "Proxy-Authorization": "Basic x" };
  const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });
  const run = async (
    steps: ((url: URL) => Response)[],
    init: RequestInit = {},
    input = "https://api.stripe.com/v1/a",
  ) => {
    calls.length = 0;
    script = (url, hop) => steps[Math.min(hop, steps.length) - 1]!(url);
    return wrapped(input, { headers: sensitive, ...init });
  };

  // Cross-origin hop onto another loopback service: no credential follows.
  await run([() => redirect(302, "http://127.0.0.1:9/other"), () => new Response("ok")]);
  const crossed = calls[1]!;
  if (crossed.url !== "http://127.0.0.1:9/other") throw new Error("Wrapper sent a loopback hop to the gateway");
  for (const name of ["authorization", "cookie", "proxy-authorization", GATEWAY_TOKEN_HEADER])
    if (crossed.headers.has(name)) throw new Error(`Cross-origin redirect kept ${name}`);
  if (calls[0]!.headers.get(GATEWAY_TOKEN_HEADER) !== "trial-token")
    throw new Error("Gateway hop did not carry the trial credential");

  // A stripped header stays stripped on a later hop back to the first origin.
  await run([
    () => redirect(307, "https://files.stripe.com/f"),
    () => redirect(307, "https://api.stripe.com/v1/b"),
    () => new Response("ok"),
  ]);
  if (calls[2]!.headers.has("authorization")) throw new Error("A stripped credential returned on a later hop");

  // Same-origin hop keeps the credential.
  await run([() => redirect(301, "/v1/c"), () => new Response("ok")]);
  if (calls[1]!.headers.get("authorization") !== "Bearer sk_secret")
    throw new Error("Same-origin redirect dropped the credential");

  // 303 after POST becomes a bodiless GET without body headers.
  await run([() => redirect(303, "/v1/d"), () => new Response("ok")], {
    method: "POST",
    body: "x=1",
    headers: { ...sensitive, "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (calls[1]!.method !== "GET" || calls[1]!.hasBody || calls[1]!.headers.has("content-type"))
    throw new Error("303 after POST did not become a bodiless GET");

  await rejects(
    () => run([() => redirect(302, "/v1/e")], { redirect: "error" }),
    /redirect mode is error/,
    "redirect: error returned the redirect",
  );
  const manual = await run([() => redirect(302, "/v1/f")], { redirect: "manual" });
  if (manual.status !== 302 || calls.length !== 1) throw new Error("redirect: manual followed the redirect");
  await rejects(
    () => run([() => redirect(302, "/v1/loop")]),
    /redirect count exceeded/,
    "Wrapper followed more than 20 redirects",
  );
  await rejects(
    () =>
      run([
        () =>
          new Response("Eval refused non-loopback transport", {
            status: 502,
            headers: { [GATEWAY_ERROR_HEADER]: "1" },
          }),
      ]),
    /Eval refused/,
    "A gateway refusal did not reject the fetch",
  );
}

/**
 * A crashed wrangler launcher must not orphan its CLI or workerd, and every
 * wrangler Node process runs with the egress guard and no update banner.
 */
export async function workerdProcessControls() {
  const dir = await mkdtemp(join(tmpdir(), "connecta-workerd-control-"));
  try {
    const main = join(dir, "worker.js");
    await writeFile(main, 'export default { fetch: () => new Response("ok") };\n');
    for (const cleanup of ["close", "killAll"] as const) {
      const dev = await wranglerDev({ name: "connecta-workerd-control", main, bootMs: 60_000 });
      const pgid = dev.process().child.pid!;
      const before = await groupMembers(pgid);
      const environments = await Promise.all(
        before.map((pid) => readFile(`/proc/${pid}/environ`, "utf8").catch(() => "")),
      );
      if (
        process.platform === "linux" &&
        !environments.some((env) => env.includes("egress-guard.cjs") && env.includes("WRANGLER_HIDE_BANNER=true"))
      )
        throw new Error("wrangler runs without the egress guard or with its update banner");
      process.kill(pgid, "SIGKILL");
      await new Promise((resolve) => dev.process().child.once("exit", resolve));
      if (!(await groupMembers(pgid)).length)
        throw new Error("Probe precondition: no wrangler process outlived its launcher");
      if (cleanup === "close") await dev.close();
      else {
        killAllProcesses();
        const deadline = Date.now() + 5_000;
        while ((await groupMembers(pgid)).length && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        await stopAllProcesses();
        await dev.close();
      }
      const survivors = await groupMembers(pgid);
      if (survivors.length)
        throw new Error(`${cleanup} after a launcher crash left process(es) ${survivors.join(", ")} running`);
    }
  } finally {
    await stopAllProcesses();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The egress guard on wrangler's Node processes. Every Node network path is
 * aimed at a sink bound to a non-loopback local interface: the sink must
 * receive nothing, every DNS path must be refused, and loopback must work.
 * Without the guard the same sink is reachable, so the control is not vacuous.
 */
export async function egressGuardControls() {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  let connections = 0,
    datagrams = 0;
  const sink = createNetServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  const udpSink = createDgramSocket("udp4").on("message", () => (datagrams += 1));
  const local = createNetServer((socket) => socket.end());
  const listen = (server: ReturnType<typeof createNetServer>, host: string) =>
    new Promise<number>((resolve) => server.listen(0, host, () => resolve((server.address() as AddressInfo).port)));
  try {
    const localPort = await listen(local, "127.0.0.1");
    let tcpPort = 0,
      udpPort = 0;
    if (address) {
      tcpPort = await listen(sink, address);
      udpPort = await new Promise<number>((resolve) => udpSink.bind(0, address, () => resolve(udpSink.address().port)));
      // Unguarded, the sink is reachable: the guarded run below proves the guard, not the network.
      await new Promise<void>((resolve, reject) =>
        connectNet(tcpPort, address)
          .once("connect", function (this: Socket) {
            this.destroy();
            resolve();
          })
          .once("error", reject),
      );
      await new Promise<void>((resolve) => createDgramSocket("udp4").send("x", udpPort, address, () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (connections !== 1 || datagrams !== 1)
        throw new Error("Probe precondition: the non-loopback sink is unreachable");
      connections = datagrams = 0;
    } else console.log("     no non-loopback IPv4 interface: sink receipt not checked, refusals still are");
    const child = spawn(
      process.execPath,
      [
        join(ROOT, "eval", "support", "egress-probe.cjs"),
        address ?? "",
        String(tcpPort),
        String(udpPort),
        String(localPort),
      ],
      { env: { ...process.env, NODE_OPTIONS: WRANGLER_ENV.NODE_OPTIONS }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(timer);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = JSON.parse(stdout.trim().split("\n").at(-1) || "{}") as Record<string, string>;
    const paths = Object.keys(result).filter((path) => !path.startsWith("loopback"));
    if (paths.length !== (address ? 23 : 9)) throw new Error(`Egress probe incomplete: ${stdout} ${stderr}`);
    for (const path of paths)
      if (result[path] !== "EVAL_EGRESS_REFUSED")
        throw new Error(`Egress guard let ${path} through: ${result[path]} (${JSON.stringify(result)})`);
    if (result["loopback tcp"] !== "connected" || result["loopback lookup"] !== "answered")
      throw new Error(`Egress guard blocked loopback: ${JSON.stringify(result)}`);
    if (connections || datagrams)
      throw new Error(`The non-loopback sink received ${connections} connection(s) and ${datagrams} datagram(s)`);
  } finally {
    for (const server of [sink, local]) if (server.listening) server.close();
    try {
      udpSink.close();
    } catch {
      // never bound
    }
  }
}

/**
 * The Worker code under test (connecta's fetch, provider calls, OAuth) sends
 * every non-loopback request through the authenticated gateway: each vendor
 * hop the fake transport handled in a worker trial arrived through the
 * gateway, none was refused, and the reference still passed against the
 * fakes. The trial's hidden secrets never surface in wrangler's output or logs.
 */
export async function gatewayRoutingControls() {
  if (!existsSync(join(ROOT, "dist", "worker.js"))) {
    const built = spawnSync("pnpm", ["run", "build"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    if (built.status !== 0) throw new Error("pnpm run build failed");
  }
  for (const id of [
    "stripe-step2-decline-join",
    "google-sheets-2",
    "github-release-once",
    "ccb-update-once",
    "granola-workspace-journey",
  ]) {
    const task = ACTIVE_TASKS.find((candidate) => candidate.id === id)!;
    const before = fakeTransportState().vendorHops;
    const played = await playReference(
      task,
      { mode: "reference", target: "worker" },
      async ({ world, trace, deployment }) => ({
        failed: gradeTask(task, { world, trace }, "six", "outcome")
          .filter((check) => !check.pass && !check.advisory && check.kind !== "route")
          .map((check) => check.id),
        requests: deployment.vendorRequests!(),
        leaks: await deployment.secretLeaks!(),
      }),
    );
    const hops = fakeTransportState().vendorHops - before;
    if (played.failed.length) throw new Error(`${id} failed on worker: ${played.failed.join(", ")}`);
    if (!played.requests.length || hops !== played.requests.length)
      throw new Error(
        `${id}: ${hops} vendor hop(s) reached the fake transport, ${played.requests.length} through the gateway`,
      );
    const stray = played.requests.filter(
      (request) => request.status === "rejected" || !request.url.startsWith("https://"),
    );
    if (stray.length) throw new Error(`${id}: gateway requests outside the fake vendors: ${JSON.stringify(stray)}`);
    if (played.leaks.findings.length) throw new Error(`${id}: ${played.leaks.findings.join("; ")}`);
    if (!played.leaks.sources.some((source) => source.includes(`${sep}logs${sep}`)))
      throw new Error(`${id}: no wrangler log file was checked for secrets (${played.leaks.sources.join(", ")})`);
  }
}

/** A batch from the frozen baseline, relabelled as a measured run on one target. */
async function fixture(target: "node" | "worker", surface: "six" | "code"): Promise<AgentResultFile> {
  const frozen = JSON.parse(
    await readFile(new URL("../baselines/gpt-6-luna-0.29.json", import.meta.url), "utf8"),
  ) as AgentResultFile;
  const id = "p5-known-read-routing";
  const source = frozen.trials.find((t) => t.task === id && t.repeat === 1)!;
  const file: AgentResultFile = {
    ...frozen,
    protocol: runProtocol("synthetic-selftest-pair"),
    config: { ...frozen.config, surface, grading: "outcome", tasks: [id], repeats: 1, target },
    trials: [
      {
        ...structuredClone(source),
        surface,
        target,
        runner: "codex",
        grading: "outcome",
        taskDefinitionsHash: runProtocol().taskDefinitionsHash,
        timeoutMs: ACTIVE_TASKS.find((t) => t.id === id)!.limits?.timeoutMs ?? frozen.config.timeoutMs,
        repeat: 1,
      },
    ],
  };
  delete file.regrade;
  return file;
}

/** Node and worker results pair only as a diagnostic, and only from measured, consistent batches. */
export async function comparatorTargetControls() {
  const fresh = fixture;
  if (!crossTarget(await fresh("node", "six"), await fresh("worker", "six")).startsWith("CROSS-TARGET DIAGNOSTIC"))
    throw new Error("Measured node and worker batches did not compare as a diagnostic");
  for (const allowMismatch of [false, true]) {
    const node = await fresh("node", "six"),
      worker = await fresh("worker", "code");
    refused(() => compare(node, worker, { allowMismatch }), "Comparison paired node and worker arms");
  }
  if (!compare(await fresh("worker", "six"), await fresh("worker", "code")).includes("target worker"))
    throw new Error("Two worker arms did not compare as worker");
  const mutations: [string, (file: AgentResultFile) => void][] = [
    ["a node trial in a worker batch", (f) => (f.trials[0]!.target = "node")],
    ["a missing protocol", (f) => delete f.protocol],
    ["a missing source tree", (f) => (f.meta.git.srcTree = "unknown")],
    ["a dirty source", (f) => (f.meta.git.dirty = true)],
    ["an offline regrade", (f) => (f.regrade = { source: "x", meta: f.meta })],
    ["an unknown target", (f) => ((f.config as { target: string }).target = "edge")],
  ];
  // Every shared batch setting must match across targets, as it must across arms.
  const settings: [string, (file: AgentResultFile) => void][] = [
    ["concurrency", (f) => (f.config.concurrency = 32)],
    ["MCP output limit", (f) => (f.config.mcpOutputTokens = 25_000)],
    ["effort", (f) => (f.config.effort = "xhigh")],
    ["maxBudgetUsd", (f) => (f.config.maxBudgetUsd = 2)],
    [
      "timeoutMs",
      (f) => {
        f.config.timeoutMs = 60_000;
        for (const trial of f.trials) trial.timeoutMs = 60_000;
      },
    ],
    ["repeats", (f) => (f.config.repeats = 2)],
    ["model set", (f) => f.config.models.push("another-model")],
    ["task set", (f) => f.config.tasks.push("p5-result-paging")],
    ["CLI version", (f) => (f.codexVersion = "codex-cli 0.0.1")],
    ["pairId", (f) => (f.protocol!.pairId = "another-pair")],
    ["source commit", (f) => (f.meta.git.commit = "0".repeat(40))],
    ["source srcTree", (f) => (f.meta.git.srcTree = "0".repeat(40))],
    ["packageVersion", (f) => (f.meta.packageVersion = "0.0.1")],
    ["node", (f) => (f.meta.node = "v1.0.0")],
    ["platform", (f) => (f.meta.platform = "plan9")],
    [
      "served model",
      (f) => {
        const metadata = f.trials[0]!.codex as { servedModel?: string } | undefined;
        if (metadata) metadata.servedModel = "another-model";
      },
    ],
  ];
  for (const [label, mutate] of settings) {
    const node = await fresh("node", "six"),
      worker = await fresh("worker", "six");
    mutate(worker);
    let message = "";
    try {
      crossTarget(node, worker);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!message.includes(`Targets must use the same ${label}`))
      throw new Error(`Cross-target diagnostic did not refuse a different ${label}: ${message || "accepted"}`);
  }
  // A trial contradicting its batch's target is refused even as a provenance diagnostic.
  const inconsistent = new Set(["a node trial in a worker batch", "an unknown target"]);
  for (const [label, mutate] of mutations) {
    // Both files carry the defect, so no cross-file inequality can be what refuses it.
    const node = await fresh("node", "six"),
      worker = await fresh("worker", "six");
    mutate(worker);
    if (!inconsistent.has(label)) mutate(node);
    refused(() => crossTarget(node, worker), `Cross-target diagnostic accepted ${label}`);
    const six = await fresh("worker", "six"),
      code = await fresh("worker", "code");
    mutate(six);
    if (!inconsistent.has(label)) mutate(code);
    refused(() => compare(six, code), `Comparison accepted ${label}`);
    if (inconsistent.has(label))
      refused(() => compare(six, code, { allowMismatch: true }), `Diagnostic comparison accepted ${label}`);
  }
}

/**
 * Opt-in injection (#1173 item 0.4): latency reaches the fakes, injected
 * connectors join every pool, a hung server cannot hold a world open, a D1
 * batch is one delayed round trip, and differing injection never pairs.
 */
export async function injectionControls() {
  // Latency is delivered on the fake's side and released with the world.
  const timed = async (injection: Injection) => {
    const world = new World({}, injection);
    await world.start();
    try {
      const started = performance.now();
      await (await fetch(world.service("tracker").url)).body?.cancel();
      return performance.now() - started;
    } finally {
      await world.stop();
    }
  };
  const [plain, delayed] = [await timed(NO_INJECTION), await timed({ ...NO_INJECTION, latencyMs: 300 })];
  if (delayed < 300 || plain >= 300) throw new Error(`Latency not delivered: ${plain} ms plain, ${delayed} ms at 300`);

  // Injected connectors join every pool, the task's own and QuickBooks' included.
  const faults = { ...NO_INJECTION, hungConnector: true, unauthorizedConnector: true };
  for (const options of [{}, { quickbooks: true }] as WorldOptions[]) {
    const world = new World(options, faults);
    await world.start();
    try {
      const ids = world.injected.ids();
      if (JSON.stringify(ids) !== JSON.stringify(["stalled", "revoked"]))
        throw new Error(`Unexpected injected connectors ${ids.join(", ")}`);
      const revoked = world.connectorSpecs().find((spec) => spec.id === "revoked");
      if (!revoked?.credential?.value) throw new Error("The 401 connector has no saved credential to reject");
      const config = evalConfig(
        {
          connectors: world.connectorSpecs(),
          extra: { pools: { programs: { tools: ["tracker"], members: ["agent:eval-machine"] } } },
          fixtures: { alice: "alice@example.com", accountA: "a", shopZone: "z" },
          readOnly: false,
          everyPool: ids,
        },
        { storage: undefined as never, executor: undefined as never, publicUrl: "http://127.0.0.1:1" },
      );
      const pools = Object.entries(config.pools ?? {});
      if (!pools.length || pools.some(([, pool]) => !ids.every((id) => pool.tools.includes(id))))
        throw new Error(`An injected connector is missing from a pool: ${JSON.stringify(config.pools)}`);
      if (!ids.every((id) => config.connectors.some((connector) => connector.id === id)))
        throw new Error("An injected connector is missing from the configuration");
      const status = await fetch(revoked.url, { method: "POST" }).then((r) => r.status);
      if (status !== 401) throw new Error(`The 401 connector answered ${status}`);
    } finally {
      await world.stop();
    }
  }

  // A request held open by the hung server cannot keep its world from stopping.
  const hung = new World({}, { ...NO_INJECTION, hungConnector: true });
  await hung.start();
  const pending = fetch(hung.connectorSpecs().find((spec) => spec.id === "stalled")!.url, { method: "POST" }).then(
    () => "answered",
    () => "closed",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stopped = await Promise.race([
    hung.stop().then(() => "stopped"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
  ]);
  if (stopped !== "stopped" || (await pending) !== "closed")
    throw new Error("The hung connector's server outlived its world");

  // One D1 batch is one delayed round trip carrying the original statements.
  const delay = 50;
  const inner = { bind: (...values: unknown[]) => ({ ...inner, values }), all: async () => ({ results: [] }) };
  let batched: unknown[] = [];
  const db = {
    prepare: () => ({ ...inner }),
    batch: async (statements: unknown[]) => ((batched = statements), []),
    exec: async () => ({}),
  } as unknown as D1Database;
  const wrapped = withD1Latency(db, delay);
  const statements = [1, 2, 3].map((n) => wrapped.prepare(`SELECT ${n}`).bind(n));
  let started = performance.now();
  await wrapped.batch(statements);
  const batchMs = performance.now() - started;
  if (batchMs < delay || batchMs >= delay * 2)
    throw new Error(`A 3-statement batch took ${batchMs} ms, not one round trip`);
  if (batched.length !== 3 || batched.some((statement) => (statement as { values?: unknown[] }).values === undefined))
    throw new Error("The batch did not receive the bound inner statements");
  started = performance.now();
  await wrapped.prepare("SELECT 1").bind(1).all();
  if (performance.now() - started < delay) throw new Error("A statement round trip was not delayed");

  // Differing injection never pairs, in either comparison; equal injection does.
  const injected = async (target: "node" | "worker", surface: "six" | "code", injection: Partial<Injection>) => {
    const file = await fixture(target, surface);
    file.config.injection = { ...NO_INJECTION, ...injection };
    return file;
  };
  if (!compare(await injected("node", "six", {}), await fixture("node", "code")).includes("Paired batch"))
    throw new Error("Recorded zero injection did not pair with a file that predates injection");
  for (const injection of [
    { latencyMs: 500 },
    { hungConnector: true },
    { unauthorizedConnector: true },
    { d1LatencyMs: 20 },
  ] as Partial<Injection>[]) {
    const six = await fixture("node", "six"),
      code = await injected("node", "code", injection);
    for (const allowMismatch of [false, true])
      refused(
        () => compare(six, code, { allowMismatch }),
        `Comparison paired different injection ${JSON.stringify(injection)}`,
      );
    if (!compare(await injected("node", "six", injection), code).includes("Paired batch"))
      throw new Error(`Equal injection ${JSON.stringify(injection)} did not pair`);
    const node = await fixture("node", "six"),
      worker = await injected("worker", "six", injection);
    refused(() => crossTarget(node, worker), `Cross-target paired different injection ${JSON.stringify(injection)}`);
    if (!injection.d1LatencyMs && !crossTarget(await injected("node", "six", injection), worker).startsWith("CROSS"))
      throw new Error(`Cross-target refused equal injection ${JSON.stringify(injection)}`);
  }
  refused(() => parseInjection(flags(["--latency-ms", "-1"])), "Negative latency accepted");
  refused(() => parseInjection(flags(["--hung-connector", "stalled"])), "A toggle accepted a value");
  if (isInjected(parseInjection(flags([])))) throw new Error("Injection is not off by default");
}
