// Node-only: runs redaction in child processes with a 128 MiB heap, which the test runner's own heap cannot bound.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Run a module script from the repository root under a 128 MiB heap; it prints one JSON value. */
function lowHeap(script: string): unknown {
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=128", "--import", "tsx", "--input-type=module", "-e", script],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  expect(result.status, result.stderr.slice(-2_000)).toBe(0);
  return JSON.parse(result.stdout);
}

it("INV-5: long credentials bound the matcher, so ordinary output survives a 128 MiB heap and echoes stay redacted", () => {
  const outcome = lowHeap(`
    const { SentSecrets } = await import("./src/sent-secrets.ts");
    const many = new SentSecrets();
    for (let i = 0; i < 20; i++) many.add("credential-" + i + "-" + "z".repeat(4096));
    const one = new SentSecrets();
    const long = "c" + "y".repeat(99_999);
    one.add(long);
    console.log(JSON.stringify({
      many: many.text("needed-id"),
      one: one.text("needed-id"),
      manyEcho: many.text(JSON.stringify({ id: "needed-id", token: "credential-19-" + "z".repeat(4096) })),
      oneEcho: one.text("before " + long + " after"),
    }));
  `);
  expect(outcome).toEqual({
    many: "needed-id",
    one: "needed-id",
    manyEcho: '{"id":"needed-id","token":"[redacted]"}',
    oneEcho: "before [redacted] after",
  });
}, 60_000);
