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

it("INV-5: a credential-bearing result with 1,000,000 metadata objects completes a direct call under a 128 MiB heap", () => {
  const outcome = lowHeap(`
    const { createMetaTools } = await import("./src/meta-tools.ts");
    const { Registry } = await import("./src/registry.ts");
    const { SentSecrets, sentSecretsFor } = await import("./src/sent-secrets.ts");
    const { memoryStorage } = await import("./src/storage/memory.ts");
    const reply = () => ({
      content: [{ type: "text", text: "ok" }],
      _meta: Array.from({ length: 1_000_000 }, () => ({})),
    });
    // A function frame, so this copy is collectable before the call builds another.
    const unchanged = (() => {
      const secrets = new SentSecrets();
      secrets.add("credential-793-long");
      const result = reply();
      return secrets.redact(result) === result;
    })();
    const silent = { debug() {}, info() {}, warn() {}, error() {} };
    const registry = new Registry([{
      id: "wire",
      kind: "mcp",
      async listTools() {
        return [{ name: "read", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }];
      },
      async callTool(_name, _args, ctx) {
        sentSecretsFor(ctx).add("credential-793-long");
        return reply();
      },
    }], { storage: memoryStorage(), logger: silent });
    const call = await createMetaTools(registry, "https://wire.test").callTool({ address: "wire.read", args: {} });
    console.log(JSON.stringify({ unchanged, isError: call.isError === true, content: call.content }));
  `);
  expect(outcome).toEqual({ unchanged: true, isError: false, content: [{ type: "text", text: "ok" }] });
});

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
});

it("INV-5: self-similar text shares long-form checks, so it cannot exhaust a 128 MiB heap and stays exact", () => {
  const outcome = lowHeap(`
    const { SentSecrets } = await import("./src/sent-secrets.ts");
    const timed = (secrets, text) => {
      const started = performance.now();
      const value = secrets.text(text);
      return { value: value.length > 64 ? value.length : value, slow: performance.now() - started > 1_000 };
    };
    const huge = new SentSecrets();
    for (let i = 0; i < 20; i++) huge.add("s".repeat(100_000) + "-end-" + i);
    const many = new SentSecrets();
    for (let i = 0; i < 20; i++) many.add("s".repeat(4_096) + "-end-" + i);
    const one = new SentSecrets();
    one.add("s".repeat(4_096) + "-end-0");
    const text = "s".repeat(4_000_000);
    console.log(JSON.stringify({
      huge: timed(huge, text),
      many: timed(many, text),
      echo: timed(one, "before " + "s".repeat(4_096) + "-end-0 after"),
      clean: timed(one, "s".repeat(1_000_000)),
    }));
  `);
  expect(outcome).toEqual({
    huge: { value: 4_000_000, slow: false },
    many: { value: 4_000_000, slow: false },
    echo: { value: "before [redacted] after", slow: false },
    clean: { value: 1_000_000, slow: false },
  });
});
