/**
 * Negative controls for the worker target (#1173 item 0.2): the vendor
 * gateway's credential and loopback refusal, the Worker-side redirect rules,
 * process-group cleanup after a launcher crash, the egress guard on wrangler's
 * own Node processes, and comparator provenance across targets.
 */
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crossTarget, compare } from "../compare.js";
import { startVendorGateway } from "../deploy/worker.js";
import { GATEWAY_ERROR_HEADER, GATEWAY_TOKEN_HEADER, VENDOR_URL_HEADER, viaGateway } from "../deploy/gateway-fetch.js";
import { routeFakeVendor } from "../fakes/transport.js";
import type { AgentResultFile } from "../report/summary.js";
import { runProtocol } from "../support/meta.js";
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
 * A crashed wrangler launcher must not orphan its CLI or workerd, and
 * wrangler's own Node processes cannot reach a non-loopback host.
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

  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `const net = require("node:net"), tls = require("node:tls");
const failed = (socket) => new Promise((resolve) => { socket.once("error", (e) => resolve(e.code)); socket.once("connect", () => { socket.destroy(); resolve("connected"); }); socket.once("secureConnect", () => { socket.destroy(); resolve("connected"); }); });
(async () => {
  const server = net.createServer((s) => s.end()).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const out = {
    net: await failed(net.connect(443, "registry.npmjs.org")),
    tls: await failed(tls.connect({ host: "1.1.1.1", port: 443 })),
    fetch: await fetch("https://registry.npmjs.org/wrangler").then(() => "connected", (e) => e.cause?.code ?? String(e)),
    loopback: await failed(net.connect(server.address().port, "127.0.0.1")),
  };
  server.close();
  console.log(JSON.stringify(out));
})();`,
    ],
    { encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: WRANGLER_ENV.NODE_OPTIONS } },
  );
  const result = JSON.parse(probe.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, string>;
  for (const kind of ["net", "tls", "fetch"])
    if (result[kind] !== "EVAL_EGRESS_REFUSED")
      throw new Error(`Egress guard let ${kind} reach the network: ${JSON.stringify(result)} ${probe.stderr}`);
  if (result.loopback !== "connected") throw new Error(`Egress guard blocked loopback: ${JSON.stringify(result)}`);
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
