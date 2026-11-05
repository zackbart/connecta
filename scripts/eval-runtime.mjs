// Shared leases keep dist/ stable while independent evals run concurrently.
// Exclusive builds wait for readers. flock releases leases on exit, including
// SIGKILL; there is no owner file, acquisition window or PID-reuse heuristic.
import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const runtimeLock = resolve("node_modules/.cache/connecta-eval-runtime.flock");

export async function withRuntimeLock(exclusive, command, args, options = {}) {
  await mkdir(resolve("node_modules/.cache"), { recursive: true });
  // Descriptor mode works with both util-linux and Homebrew discoteq/flock.
  // All three processes share the open file description: acquiring flock,
  // this wrapper, then the command. Killing the wrapper cannot unlock a live
  // command, and the kernel releases the lease after the last holder exits.
  const lease = await open(runtimeLock, "a");
  let child;
  const forward = (signal) => child?.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  const wait = (proc) =>
    new Promise((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
  try {
    child = spawn("flock", [exclusive ? "-x" : "-s", "-w", "1800", "3"], {
      ...options,
      stdio: ["inherit", "inherit", "inherit", lease.fd],
    });
    let code;
    try {
      code = await wait(child);
    } catch (error) {
      throw new Error("Eval runtime locking requires flock (install with Homebrew: brew install flock).", {
        cause: error,
      });
    }
    if (code !== 0) return code;
    child = spawn(command, args, {
      ...options,
      stdio: ["inherit", "inherit", "inherit", lease.fd],
    });
    return await wait(child);
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
    await lease.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [entry, ...args] = process.argv.slice(2);
  if (entry === "--locked") {
    process.argv.splice(2, 2);
    await import("../eval/" + args[0] + ".ts");
  } else if (entry === "--build") {
    process.exitCode = await withRuntimeLock(true, "sh", [
      "-c",
      "pnpm run providers:generate && pnpm run clean && node node_modules/typescript/bin/tsc -p tsconfig.build.json && node scripts/prune-declarations.mjs",
    ]);
  } else {
    // Build before taking the shared lease: upgrading with other readers would
    // deadlock. Suppress the entrypoint's nested build once it has the lease.
    // Match the entrypoints' --name value / --flag parsing, including repeated flags.
    const flags = new Map();
    for (let i = 0; i < args.length; i++) {
      if (!args[i].startsWith("--")) continue;
      const value = args[i + 1];
      flags.set(args[i].slice(2), value && !value.startsWith("--") ? args[++i] : "true");
    }
    const needsBuild =
      (entry === "selftest" && !existsSync("dist/worker.js")) ||
      (!flags.has("no-build") &&
        (entry === "run-smoke" || (entry === "run-agent" && flags.get("target") === "worker")));
    // The Eve runner imports the helper from its own dist/, which no other step
    // builds. Rebuild it so a batch cannot test a stale helper.
    const needsEveHelper =
      !flags.has("no-build") &&
      ((entry === "selftest" && flags.has("eve-only")) || (entry === "run-agent" && flags.get("runner") === "eve"));
    const run = (args) =>
      new Promise((resolve, reject) => {
        const child = spawn("pnpm", args, { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });
    let code = 0;
    if (needsBuild) code = await run(["run", "build"]);
    if (!code && needsEveHelper) code = await run(["--filter", "@zackbart/connecta-eve", "run", "build"]);
    process.exitCode =
      code ||
      (await withRuntimeLock(false, process.execPath, [
        "--import",
        "tsx",
        process.argv[1],
        "--locked",
        entry,
        ...args,
        ...(needsBuild ? ["--no-build"] : []),
      ]));
  }
}
