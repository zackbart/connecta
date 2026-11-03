// Serialize eval consumers of this checkout's mutable dist/ before loading it.
// Different checkouts retain independent locks and can run concurrently.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
const lock = resolve("node_modules/.cache/connecta-eval-runtime.lock");
await mkdir(resolve("node_modules/.cache"), { recursive: true });
// A build spawned by the owning eval may reuse its lease; unrelated builds
// and independent eval processes must wait before touching/loading dist.
const ownerFile = resolve(lock, "owner");
const inherited = process.env.CONNECTA_RUNTIME_LEASE;
const reentrant = inherited && (await readFile(ownerFile, "utf8").catch(() => "")) === inherited;
if (!reentrant) {
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline)
        throw new Error(`Eval runtime is locked: ${lock}. Check its owner before removing a stale lock.`);
      await setTimeout(250);
    }
  }
  process.once("exit", () => rmSync(lock, { recursive: true, force: true }));
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      // Let an eval's orderly cleanup retain the lease until it exits.
      if (process.listenerCount(signal) === 1) process.exit(code);
    });
  }
  process.env.CONNECTA_RUNTIME_LEASE = `${process.pid}:${randomUUID()}`;
  await writeFile(ownerFile, process.env.CONNECTA_RUNTIME_LEASE);
}
const [entry] = process.argv.splice(2, 1);
if (entry === "--build") {
  // Static repository commands, with no caller-provided shell text.
  const result = spawnSync(
    "sh",
    [
      "-c",
      "pnpm run providers:generate && pnpm run clean && node node_modules/typescript/bin/tsc -p tsconfig.build.json && node scripts/prune-declarations.mjs",
    ],
    { stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
} else {
  await import("../eval/" + entry + ".ts");
}
