// Shared leases keep dist/ stable while independent evals run concurrently.
// Exclusive builds wait for readers. flock releases leases on exit, including
// SIGKILL; there is no owner file, acquisition window or PID-reuse heuristic.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const runtimeLock = resolve("node_modules/.cache/connecta-eval-runtime.flock");

export async function withRuntimeLock(exclusive, command, args, options = {}) {
  await mkdir(resolve("node_modules/.cache"), { recursive: true });
  const child = spawn(
    "flock",
    ["--no-fork", exclusive ? "--exclusive" : "--shared", "--timeout", "1800", runtimeLock, command, ...args],
    { stdio: "inherit", ...options },
  );
  const forward = (signal) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", (error) => {
        reject(
          new Error("Eval runtime locking requires flock (install with Homebrew: brew install flock).", {
            cause: error,
          }),
        );
      });
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
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
    let code = 0;
    if (needsBuild) {
      const child = spawn("pnpm", ["run", "build"], { stdio: "inherit" });
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });
    }
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
