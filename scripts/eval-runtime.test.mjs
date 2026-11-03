import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";

const runtime = new URL("./eval-runtime.mjs", import.meta.url).href;

test(
  "shared eval leases, exclusive builds, SIGKILL recovery and separate checkouts",
  { timeout: 120_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "connecta-lock-control-"));
    const other = await mkdtemp(join(tmpdir(), "connecta-lock-control-"));
    const children = [];
    function start(exclusive, cwd = dir) {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { withRuntimeLock } from ${JSON.stringify(runtime)};
      process.exitCode = await withRuntimeLock(${exclusive}, process.execPath, ["-e",
        'console.log(process.pid); process.stdin.resume();']);
    `,
        ],
        { cwd, stdio: ["pipe", "pipe", "inherit"] },
      );
      children.push(child);
      const lines = createInterface({ input: child.stdout });
      const exited = once(child, "exit");
      const ready = once(lines, "line").then(([line]) => Number(line));
      return { child, ready, exited };
    }
    try {
      const first = start(false);
      const pid = await first.ready;
      const second = start(false);
      await second.ready; // same-checkout readers proceed while the first is live
      const lock = join(dir, "node_modules/.cache/connecta-eval-runtime.flock");
      assert.equal(spawnSync("flock", ["-n", "-x", lock, "true"]).status, 1, "build must be excluded by readers");
      const build = start(true);
      let acquired = false;
      void build.ready.then(() => {
        acquired = true;
      });
      const separate = start(true, other);
      await separate.ready; // another checkout never queues behind this one
      assert.equal(acquired, false, "exclusive build entered while eval readers were active");
      second.child.stdin.end();
      await second.exited;
      assert.equal(acquired, false, "build entered while one reader remained");
      process.kill(pid, "SIGKILL"); // kill the actual OS lock holder, bypassing all exit hooks
      await first.exited;
      const buildPid = await build.ready;
      assert.equal(spawnSync("flock", ["-n", "-s", lock, "true"]).status, 1, "eval must be excluded by a build");
      process.kill(buildPid, "SIGKILL");
      await build.exited;
      const successor = start(true);
      await successor.ready; // no stale owner directory or 30-minute delay
      successor.child.stdin.end();
      separate.child.stdin.end();
      await Promise.all([successor.exited, separate.exited]);
    } finally {
      for (const child of children) child.stdin.end();
      await Promise.all(children.filter((child) => child.exitCode === null).map((child) => once(child, "exit")));
      await Promise.all([dir, other].map((path) => rm(path, { recursive: true, force: true })));
    }
  },
);
