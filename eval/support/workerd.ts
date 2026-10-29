/**
 * Bounded child processes for the workerd targets: `wrangler dev` with the
 * Worker example's own compatibility date, flags and bindings, in its own
 * process group. Every group still running when the harness exits, or when it
 * receives SIGINT/SIGTERM, is killed, so no workerd outlives the run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_readRawConfig } from "wrangler";
import { ROOT } from "./meta.js";

/**
 * Process groups by leader pid. A group stays tracked until no live member
 * remains, whatever the leader did: wrangler's launcher can exit or crash
 * while its CLI and workerd processes keep running in the same group.
 */
const groups = new Set<number>();

/** Live (non-zombie) members of a process group; `kill(-pgid, 0)` where /proc is absent. */
export async function groupMembers(pgid: number): Promise<number[]> {
  try {
    const members: number[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = await readFile(`/proc/${entry}/stat`, "utf8");
      } catch {
        continue; // exited while scanning
      }
      // Fields after the parenthesised command: state, ppid, pgrp.
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(pgrp) === pgid && state !== "Z") members.push(Number(entry));
    }
    return members;
  } catch {
    try {
      process.kill(-pgid, 0);
      return [pgid];
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM" ? [pgid] : [];
    }
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch {
    // no member left to signal
  }
}

async function settle(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!(await groupMembers(pgid)).length) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

/** SIGTERM, then SIGKILL after 5 s; tracking ends only when the group is empty. */
async function stopGroup(pgid: number): Promise<void> {
  if (!groups.has(pgid)) return;
  signalGroup(pgid, "SIGTERM");
  if (!(await settle(pgid, 5_000))) {
    signalGroup(pgid, "SIGKILL");
    if (!(await settle(pgid, 5_000))) throw new Error(`Process group ${pgid} survived SIGKILL`);
  }
  groups.delete(pgid);
}

let guarded = false;
function guardExit() {
  if (guarded) return;
  guarded = true;
  // Synchronous last resort; an orderly stop has already emptied the set.
  process.once("exit", killAllProcesses);
}

/** Kill every tracked group now; for a second interrupt that cannot wait for an orderly stop. */
export function killAllProcesses() {
  for (const pgid of groups) signalGroup(pgid, "SIGKILL");
}

/** For harnesses with no orderly interrupt of their own: kill every group, then exit. */
export function killChildrenOnSignal() {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      killAllProcesses();
      process.exit(130);
    });
}

export function startProcess(command: string, argv: string[], options: { cwd: string; env?: Record<string, string> }) {
  guardExit();
  const child = spawn(command, argv, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  if (child.pid !== undefined) groups.add(child.pid);
  let output = "";
  child.stdout?.on("data", (chunk) => (output = (output + String(chunk)).slice(-8_000)));
  child.stderr?.on("data", (chunk) => (output = (output + String(chunk)).slice(-8_000)));
  return { child, output: () => output };
}

/** Stop the child's whole process group, including members that outlived it. */
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) await stopGroup(child.pid);
}

/** Stop every tracked group, for a harness that is about to exit. */
export async function stopAllProcesses(): Promise<void> {
  await Promise.all([...groups].map(stopGroup));
}

/**
 * Wrangler's own Node process may not reach the network: no update check, no
 * metrics, and a preload that refuses every non-loopback TCP/TLS connect.
 */
export const WRANGLER_ENV = {
  WRANGLER_SEND_METRICS: "false",
  // The startup banner is the update check's unconditional trigger.
  WRANGLER_HIDE_BANNER: "true",
  CI: "1",
  NODE_OPTIONS: [
    process.env.NODE_OPTIONS,
    `--require ${JSON.stringify(join(ROOT, "eval", "support", "egress-guard.cjs"))}`,
  ]
    .filter(Boolean)
    .join(" "),
};

export async function waitForHealth(origin: string, child: ChildProcess, output: () => string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`process exited before /health was ready:\n${output().slice(-4_000)}`);
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`/health not ready within ${timeoutMs}ms:\n${output().slice(-4_000)}`);
}

export interface WranglerDev {
  origin: string;
  /** Local D1 and wrangler's bundle scratch; removed by close(). */
  persist: string;
  process(): ReturnType<typeof startProcess>;
  /** Stop and boot a fresh workerd process over the same persisted state. */
  restart(): Promise<void>;
  /** Stop workerd only; state stays for inspection until close(). */
  stop(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boot `main` under `wrangler dev` and wait for /health, with the Worker example's compatibility
 * date, flags, D1 and Worker Loader bindings. `vars` go into the generated
 * config, so large or multi-line values need no shell quoting.
 */
export async function wranglerDev(options: {
  name: string;
  main: string;
  vars?: Record<string, string>;
  /** Extra `--var NAME:value` pairs, for values that must stay out of the config file. */
  cliVars?: string[];
  /** Pass `PUBLIC_URL:<origin>` on the command line, as the smoke always has. */
  publicUrlVar?: boolean;
  bootMs?: number;
}): Promise<WranglerDev> {
  const persist = await mkdtemp(join(tmpdir(), `${options.name}-`));
  const { rawConfig: example } = experimental_readRawConfig({
    config: join(ROOT, "examples", "worker", "wrangler.jsonc"),
  });
  const config = join(persist, "wrangler.json");
  let port = 0;
  let inspector = 0;
  let origin = "";
  const choosePorts = async () => {
    port = await unclaimedPort();
    // Concurrent workerd processes must not share the default devtools port.
    inspector = await unclaimedPort();
    origin = `http://127.0.0.1:${port}`;
  };
  await writeFile(
    config,
    JSON.stringify({
      name: options.name,
      main: options.main,
      compatibility_date: example.compatibility_date,
      compatibility_flags: example.compatibility_flags,
      d1_databases: example.d1_databases,
      worker_loaders: example.worker_loaders,
      ...(options.vars ? { vars: options.vars } : {}),
    }),
  );
  const boot = () =>
    startProcess(
      join(ROOT, "node_modules", ".bin", "wrangler"),
      [
        "dev",
        "--config",
        config,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        String(inspector),
        "--persist-to",
        persist,
        "--show-interactive-dev-session=false",
        ...[...(options.publicUrlVar ? [`PUBLIC_URL:${origin}`] : []), ...(options.cliVars ?? [])].flatMap(
          (variable) => ["--var", variable],
        ),
      ],
      { cwd: ROOT, env: WRANGLER_ENV },
    );
  const bootMs = options.bootMs ?? 90_000;
  let proc: ReturnType<typeof startProcess> | undefined;
  const close = async () => {
    if (proc) await stopProcess(proc.child);
    // wrangler's bundle scratch lands beside the config, inside this directory.
    await rm(persist, { recursive: true, force: true });
  };
  try {
    for (let attempt = 1; ; attempt++) {
      await choosePorts();
      proc = boot();
      try {
        await waitForHealth(origin, proc.child, proc.output, bootMs);
        break;
      } catch (error) {
        await stopProcess(proc.child);
        if (attempt >= 3 || !/EADDRINUSE|address already in use/i.test(proc.output())) throw error;
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  let live = proc;
  return {
    origin,
    persist,
    process: () => live,
    restart: async () => {
      await stopProcess(live.child);
      live = proc = boot();
      await waitForHealth(origin, live.child, live.output, bootMs);
    },
    stop: () => stopProcess(live.child),
    close,
  };
}

/**
 * A free port below the kernel's ephemeral range. wrangler binds seconds after
 * the port is chosen; a port from `freePort()` could meanwhile go to a fake
 * listening on port 0, and this process's health polls would land in that
 * fake's ledger.
 */
async function unclaimedPort(): Promise<number> {
  let floor = 32_768;
  try {
    floor = Number((await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8")).trim().split(/\s+/)[0]) || floor;
  } catch {
    // Not Linux: the IANA ephemeral range starts at 49152; stay below the Linux default too.
  }
  for (let tries = 0; tries < 50; tries++) {
    const candidate = 10_000 + Math.floor(Math.random() * Math.max(1, floor - 10_000));
    const server = createServer();
    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => resolve(true));
    });
    if (bound) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return candidate;
    }
  }
  throw new Error("No unclaimed loopback port below the ephemeral range");
}
