/**
 * `npm run eval:smoke -- [--targets a,b] [--no-build] [--out path]` — boot both
 * deployment shapes from this checkout and drive them over MCP and a browser.
 *
 * Targets:
 *   node-template   `connecta init` output, run with tsx against this build
 *   node-fakes      the Node shape the agent evals use, over loopback fakes
 *   worker-example  examples/worker, unmodified, under `wrangler dev`
 *   worker-fakes    the Worker example's composition over loopback fakes
 *
 * Each target: /health, MCP initialize, the exact seven-tool list, a read
 * through execute_code, a call through call_destructive_tool (a verified
 * downstream write where the target has a write-capable tool), and the
 * operator UI loading in headless Chromium with a screenshot.
 *
 * `npm run build` runs first: the template and the Worker import the package
 * by name, which resolves to dist/. No LLM; needs no network.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startNodeDeployment } from "./deploy/node.js";
import { World } from "./fakes/world.js";
import type { SmokeCheck, SmokeResultFile, SmokeTarget } from "./report/summary.js";
import { connectMcp, parseJson, type McpSession } from "./support/mcp.js";
import { flags, ROOT, runMeta, stamp } from "./support/meta.js";
import { freePort } from "./support/serve.js";

const SEVEN = [
  "authorize_connector",
  "call_destructive_tool",
  "call_tool",
  "execute_code",
  "get_result",
  "search_tools",
  "skills",
];

const args = flags(process.argv.slice(2));
const out = resolve(args.get("out") ?? join(ROOT, "eval", "results", `smoke-${stamp()}.json`));
const selected = (args.get("targets") ?? "node-template,node-fakes,worker-example,worker-fakes").split(",");

async function step(checks: SmokeCheck[], name: string, run: () => Promise<string | void>): Promise<boolean> {
  const started = performance.now();
  try {
    const detail = await run();
    checks.push({ name, pass: true, ms: Math.round(performance.now() - started), ...(detail ? { detail } : {}) });
    return true;
  } catch (error) {
    checks.push({
      name,
      pass: false,
      ms: Math.round(performance.now() - started),
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 600),
    });
    return false;
  }
}

function startProcess(command: string, argv: string[], options: { cwd: string; env?: Record<string, string> }) {
  const child = spawn(command, argv, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output = (output + String(chunk)).slice(-8_000)));
  child.stderr?.on("data", (chunk) => (output = (output + String(chunk)).slice(-8_000)));
  return { child, output: () => output };
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  // wrangler and tsx both fork; signal the whole group.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }, 5_000);
  await once(child, "exit").catch(() => undefined);
  clearTimeout(timer);
}

async function waitForHealth(origin: string, child: ChildProcess, output: () => string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`process exited before /health was ready:\n${output().slice(-1_500)}`);
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`/health not ready within ${timeoutMs}ms:\n${output().slice(-1_500)}`);
}

interface Battery {
  origin: string;
  headers: Record<string, string>;
  readCode: string;
  expectRead(result: unknown): string;
  write: { address: string; args: Record<string, unknown>; verify(): string };
}

async function mcpBattery(checks: SmokeCheck[], battery: Battery): Promise<void> {
  await step(checks, "GET /health", async () => {
    const health = (await (await fetch(`${battery.origin}/health`)).json()) as {
      status?: string;
      executor?: { name?: string };
      connectors?: number;
    };
    if (health.status !== "ok") throw new Error(`status ${String(health.status)}`);
    return `executor ${health.executor?.name ?? "?"}, ${health.connectors ?? "?"} connectors`;
  });
  let session: McpSession | undefined;
  await step(checks, "MCP initialize", async () => {
    session = await connectMcp(`${battery.origin}/mcp`, battery.headers);
    return `server ${session.serverName ?? "?"}`;
  });
  if (!session) return;
  const live = session;
  try {
    await step(checks, "tools/list is exactly the seven meta-tools", async () => {
      const names = (await live.listTools()).map((tool) => tool.name).sort();
      if (JSON.stringify(names) !== JSON.stringify(SEVEN)) throw new Error(`got ${names.join(", ")}`);
      return names.join(", ");
    });
    await step(checks, "read through execute_code", async () => {
      const result = await live.call("execute_code", { code: battery.readCode });
      if (result.isError) throw new Error(result.text.slice(0, 400));
      const parsed = parseJson(result.text) as { result?: unknown } | undefined;
      return battery.expectRead(parsed?.result);
    });
    await step(checks, `call_destructive_tool ${battery.write.address}`, async () => {
      const result = await live.call("call_destructive_tool", {
        address: battery.write.address,
        args: battery.write.args,
        reason: "deployment smoke",
      });
      if (result.isError) throw new Error(result.text.slice(0, 400));
      return battery.write.verify();
    });
  } finally {
    await live.close();
  }
}

/**
 * Load the operator page. With a bearer deployment the page asks a human to
 * paste the token, so the check does exactly that and waits for the
 * connections to render; behind Access the identity is already there.
 */
async function uiCheck(checks: SmokeCheck[], origin: string, token?: string): Promise<string | undefined> {
  let screenshot: string | undefined;
  await step(checks, "operator UI loads in Chromium", async () => {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const response = await page.goto(`${origin}/`, { waitUntil: "networkidle" });
      if (!response?.ok()) throw new Error(`HTTP ${response?.status()}`);
      if (token) {
        const input = page.locator("input").first();
        await input.fill(token);
        await input.press("Enter");
        await page.getByText("Point an MCP client at this endpoint").waitFor({ timeout: 10_000 });
        await page.waitForLoadState("networkidle");
      }
      const text = (await page.innerText("body")).replace(/\s+/g, " ").trim();
      screenshot = (await page.screenshot({ fullPage: true })).toString("base64");
      if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
      if (!text) throw new Error("empty page");
      return text.slice(0, 160);
    } finally {
      await browser.close();
    }
  });
  return screenshot;
}

// ------------------------------------------------------------------ targets

async function nodeTemplate(): Promise<SmokeTarget> {
  const checks: SmokeCheck[] = [];
  const work = await mkdtemp(join(tmpdir(), "connecta-smoke-template-"));
  const app = join(work, "app");
  const target: SmokeTarget = {
    target: "node-template",
    description: "connecta init output (templates/node), unmodified, run with tsx against this checkout's build",
    status: "fail",
    checks,
  };
  let proc: ReturnType<typeof startProcess> | undefined;
  try {
    const ready = await step(checks, "connecta init + link this build", async () => {
      const init = spawnSync(process.execPath, [join(ROOT, "bin", "connecta.mjs"), "init", app], { encoding: "utf8" });
      if (init.status !== 0) throw new Error(init.stderr || init.stdout);
      await mkdir(join(app, "node_modules", "@zackbart"), { recursive: true });
      await symlink(ROOT, join(app, "node_modules", "@zackbart", "connecta"), "dir");
      return app;
    });
    if (!ready) return target;
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const token = randomBytes(18).toString("base64url");
    proc = startProcess(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
      cwd: app,
      env: {
        CONNECTA_TOKEN: token,
        PORT: String(port),
        PUBLIC_URL: origin,
        CONNECTA_STATE_FILE: join(work, "state.json"),
      },
    });
    const running = proc;
    const booted = await step(checks, "boot", () => waitForHealth(origin, running.child, running.output));
    if (!booted) return target;
    const headers = { Authorization: `Bearer ${token}` };
    await mcpBattery(checks, {
      origin,
      headers,
      readCode: `async () => (await connecta.call("time.get_now", {})).now`,
      expectRead: (result) => {
        if (typeof result !== "string" || Number.isNaN(Date.parse(result))) throw new Error(`unexpected ${JSON.stringify(result)}`);
        return `time.get_now → ${result}`;
      },
      write: {
        address: "time.get_now",
        args: {},
        verify: () => "route exercised; the template ships no write-capable tool, so there is no write to verify",
      },
    });
    target.screenshot = await uiCheck(checks, origin, token);
    return target;
  } finally {
    if (proc) await stopProcess(proc.child);
    await rm(work, { recursive: true, force: true });
    target.status = checks.every((item) => item.pass) ? "pass" : "fail";
  }
}

async function nodeFakes(): Promise<SmokeTarget> {
  const checks: SmokeCheck[] = [];
  const target: SmokeTarget = {
    target: "node-fakes",
    description: "the agent-eval deployment: template composition + vault, fakes as remoteMcp() over loopback HTTP",
    status: "fail",
    checks,
  };
  const world = new World();
  await world.start();
  const deployment = await startNodeDeployment(world.connectorSpecs());
  try {
    const headers = { Authorization: `Bearer ${deployment.token}` };
    await mcpBattery(checks, {
      origin: deployment.origin,
      headers,
      readCode: `async () => (await connecta.call("tracker.search_issues", { project: "web", status: "open" })).total`,
      expectRead: (result) => {
        if (result !== 13) throw new Error(`expected 13 open web issues, got ${JSON.stringify(result)}`);
        return "13 open web issues";
      },
      write: {
        address: "tracker.close_issue",
        args: { id: "WEB-105" },
        verify: () => {
          const calls = world.ledger.calls.filter((call) => call.tool === "close_issue");
          const issue = world.tracker.issues.find((candidate) => candidate.id === "WEB-105");
          if (calls.length !== 1 || issue?.status !== "closed") {
            throw new Error(`close_issue calls ${calls.length}, WEB-105 ${issue?.status}`);
          }
          return "WEB-105 closed in the fake; exactly one downstream write";
        },
      },
    });
    target.screenshot = await uiCheck(checks, deployment.origin, deployment.token);
    return target;
  } finally {
    await deployment.close();
    await world.stop();
    target.status = checks.every((item) => item.pass) ? "pass" : "fail";
  }
}

async function worker(kind: "worker-example" | "worker-fakes"): Promise<SmokeTarget> {
  const checks: SmokeCheck[] = [];
  const target: SmokeTarget = {
    target: kind,
    description:
      kind === "worker-example"
        ? "examples/worker, unmodified, under wrangler dev (workerd, local KV, Worker Loader) behind an Access stand-in"
        : "the Worker example's composition with loopback fakes as connectors, under wrangler dev",
    status: "fail",
    checks,
  };
  const world = kind === "worker-fakes" ? new World() : undefined;
  await world?.start();
  const persist = await mkdtemp(join(tmpdir(), "connecta-smoke-wrangler-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const vars = [
    `PUBLIC_URL:${origin}`,
    `CREDENTIAL_ENCRYPTION_KEY:${randomBytes(32).toString("base64")}`,
    ...(kind === "worker-example" ? ["DOWNSTREAM_TOKEN:unused-in-smoke"] : []),
    ...(world
      ? [`TRACKER_URL:${world.service("tracker").url}`, `CHAT_URL:${world.service("chat").url}`]
      : []),
  ];
  const proc = startProcess(
    join(ROOT, "node_modules", ".bin", "wrangler"),
    [
      "dev",
      "--config", join(ROOT, "eval", "deploy", `wrangler.${kind}.jsonc`),
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--persist-to", persist,
      "--show-interactive-dev-session=false",
      ...vars.flatMap((variable) => ["--var", variable]),
    ],
    { cwd: ROOT, env: { WRANGLER_SEND_METRICS: "false", CI: "1" } },
  );
  try {
    const booted = await step(checks, "boot (wrangler dev)", () => waitForHealth(origin, proc.child, proc.output, 90_000));
    if (!booted) return target;
    await mcpBattery(
      checks,
      kind === "worker-example"
        ? {
            origin,
            headers: {},
            readCode: `async () => (await connecta.call("echo.shout", { text: "hello" })).shouted`,
            expectRead: (result) => {
              if (result !== "HELLO") throw new Error(`unexpected ${JSON.stringify(result)}`);
              return "echo.shout → HELLO (Dynamic Worker executor)";
            },
            write: {
              address: "echo.shout",
              args: { text: "route" },
              verify: () => "route exercised; the example ships no write-capable tool (notion needs a real token)",
            },
          }
        : {
            origin,
            headers: {},
            readCode: `async () => (await connecta.call("tracker.search_issues", { project: "web", status: "open" })).total`,
            expectRead: (result) => {
              if (result !== 13) throw new Error(`expected 13, got ${JSON.stringify(result)}`);
              return "13 open web issues (Dynamic Worker executor → loopback fake)";
            },
            write: {
              address: "chat.post_message",
              args: { channel: "eng", text: "smoke from workerd" },
              verify: () => {
                const posts = world!.posts("eng");
                if (posts.length !== 1) throw new Error(`${posts.length} posts landed`);
                return "one message landed in the fake #eng";
              },
            },
          },
    );
    target.screenshot = await uiCheck(checks, origin);
    return target;
  } finally {
    await stopProcess(proc.child);
    await world?.stop();
    await rm(persist, { recursive: true, force: true });
    // wrangler leaves its bundle scratch beside the config.
    await rm(join(ROOT, "eval", "deploy", ".wrangler"), { recursive: true, force: true });
    target.status = checks.every((item) => item.pass) ? "pass" : "fail";
  }
}

// ---------------------------------------------------------------------- run

if (!args.has("no-build")) {
  console.error("[smoke] npm run build");
  const built = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  if (built.status !== 0) throw new Error("npm run build failed");
}
const runners: Record<string, () => Promise<SmokeTarget>> = {
  "node-template": nodeTemplate,
  "node-fakes": nodeFakes,
  "worker-example": () => worker("worker-example"),
  "worker-fakes": () => worker("worker-fakes"),
};
const targets: SmokeTarget[] = [];
for (const name of selected) {
  const run = runners[name];
  if (!run) throw new Error(`unknown target ${name}; known: ${Object.keys(runners).join(", ")}`);
  const result = await run();
  targets.push(result);
  console.error(`[smoke] ${result.status.toUpperCase().padEnd(5)} ${result.target}`);
  for (const item of result.checks) {
    console.error(`[smoke]   ${item.pass ? "ok  " : "FAIL"} ${item.name} (${item.ms}ms)${item.detail ? ` — ${item.detail.slice(0, 200)}` : ""}`);
  }
}
const file: SmokeResultFile = { kind: "connecta-eval/smoke", version: 1, meta: runMeta(), targets };
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(file, null, 1)}\n`);
console.error(`[smoke] results: ${out}`);
if (targets.some((target) => target.status === "fail")) process.exitCode = 1;
