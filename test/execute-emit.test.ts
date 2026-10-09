// The host side of the emission channel (design record M1–M10): strict block
// validation, loud budgets, delivery order, discard on failure, and the
// byte-for-byte promise for programs that never emit. The cross-executor arm
// lives in the guest API contract cases, which run the same programs on
// QuickJS and the Dynamic Worker.

import { describe, expect, it, vi } from "vitest";
import {
  buildSandboxProviders,
  createExecuteTool,
  EmitCollector,
  EXECUTE_MAX_EMITTED_BLOCKS,
  EXECUTE_MAX_EMITTED_BYTES,
} from "../src/execute.js";
import { jsonResult } from "../src/meta-tools.js";
import { SentSecrets } from "../src/sent-secrets.js";
import type { Executor } from "../src/types.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { calcConnector, makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

function emitHandler(executor: Executor, config: Parameters<typeof createExecuteTool>[5] = {}) {
  return createExecuteTool(makeRegistry([calcConnector]), BASE, executor, silentLogger, undefined, config);
}

describe("native presentation retention", () => {
  async function provider(
    raw: unknown,
    sink = new EmitCollector(EXECUTE_MAX_EMITTED_BYTES, EXECUTE_MAX_EMITTED_BLOCKS),
    sentSecrets?: SentSecrets,
  ) {
    const providers = await buildSandboxProviders(
      makeRegistry([
        {
          id: "native",
          kind: "mcp",
          async listTools() {
            return [{ name: "read", annotations: { readOnlyHint: true } }];
          },
          async callTool() {
            return raw;
          },
        },
      ]),
      BASE,
      silentLogger,
      undefined,
      { emitCollector: sink, ...(sentSecrets ? { sentSecrets } : {}) },
    );
    return required(providers.find((p) => p.name === "connecta")).fns;
  }

  it("INV-3 INV-7: oversized structured data pages without visiting or cloning a million metadata objects", async () => {
    const items = Array.from({ length: 1_000_000 }, () => ({}));
    let visits = 0;
    const raw = {
      content: [
        {
          type: "resource_link",
          uri: "asset://metadata",
          name: "metadata",
          get _meta() {
            visits++;
            return { items };
          },
        },
      ],
      structuredContent: { pad: "p".repeat(1_100_000) },
    };
    const fns = await provider(raw);
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      const result = await required(fns.call)("native.read");
      expect(result).toMatchObject({ format: "paged", totalBytes: 1_100_010, resultId: expect.any(String) });
      expect(visits).toBe(0);
      expect(clone.mock.calls.some(([input]) => input === raw || input === raw.content || input === items)).toBe(false);
    } finally {
      clone.mockRestore();
    }
  });

  it.each([false, true])(
    "INV-3: cyclic custom-connector presentation is refused cleanly with structured data %s",
    async (structured) => {
      const meta: Record<string, unknown> = {};
      meta.self = meta;
      const sink = new EmitCollector(10_000, 10);
      const fns = await provider(
        {
          content: [{ type: "resource_link", uri: "asset://cycle", name: "cycle", _meta: meta }],
          ...(structured ? { structuredContent: { ok: true } } : {}),
        },
        sink,
      );
      const result = await required(fns.call)("native.read");
      if (structured)
        expect(result).toMatchObject({
          value: { data: { ok: true }, format: "json" },
          native: { value: { format: "paged", truncated: true } },
        });
      else expect(result).toMatchObject({ format: "paged", truncated: true });
      const notice = structured
        ? (result as { native: { value: Record<string, unknown> } }).native.value
        : (result as Record<string, unknown>);
      expect(notice).not.toHaveProperty("resultId");
      expect(notice.hint).toContain("acyclic JSON");
      expect(sink.blocks).toEqual([]);
      // A refusal mints no reference that a guest can replay.
      await expect(required(fns.emit)({ ref: "forged" })).rejects.toThrow();
    },
  );

  it("INV-3 INV-5: redacted native snapshots preserve metadata within retention and emission budgets", async () => {
    const secrets = new SentSecrets();
    const secret = "credential".repeat(100);
    secrets.add(secret);
    const sink = new EmitCollector(EXECUTE_MAX_EMITTED_BYTES, EXECUTE_MAX_EMITTED_BLOCKS);
    const fns = await provider(
      {
        content: [
          { type: "resource_link", uri: "asset://redacted", name: "redacted", _meta: { pad: secret.repeat(1100) } },
        ],
        structuredContent: { ok: true },
      },
      sink,
      secrets,
    );
    const result = (await required(fns.call)("native.read")) as {
      native: { ref: string; value: Record<string, unknown> };
    };
    expect(result).toMatchObject({ native: { ref: expect.any(String), value: { format: "json" } } });
    await required(fns.emit)({ ref: result.native.ref });
    expect(sink.blocks).toEqual([
      // Adjacent echoes merge into one placeholder.
      { type: "resource_link", uri: "asset://redacted", name: "redacted", _meta: { pad: "[redacted]" } },
    ]);
  });

  it.each(["nodes", "depth", "bytes", "escaped bytes"])(
    "INV-3: native %s bounds refuse presentation while preserving structured data",
    async (bound) => {
      let meta: unknown =
        bound === "nodes" ? Array.from({ length: 40_000 }, () => ({})) : "x".repeat(EXECUTE_MAX_EMITTED_BYTES + 1);
      if (bound === "escaped bytes") meta = "\u0000".repeat(700_000);
      if (bound === "depth") {
        meta = {};
        for (let i = 0; i < 65; i++) meta = { nested: meta };
      }
      const fns = await provider({
        content: [{ type: "resource_link", uri: "asset://bounded", name: "bounded", _meta: { meta } }],
        structuredContent: { ok: true },
      });
      expect(await required(fns.call)("native.read")).toMatchObject({
        value: { data: { ok: true }, format: "json" },
        native: { value: { format: "paged", truncated: true } },
      });
    },
  );
});

describe("EmitCollector validation (M1)", () => {
  const collector = () => new EmitCollector(10_000, 10);

  it("INV-3: rejects every invalid shape and accepts nothing", () => {
    const invalid: Array<[unknown, string]> = [
      ["bare", "content block"],
      [null, "content block"],
      [[{ type: "text", text: "x" }], "content block"],
      [{ type: "resource_link", uri: "https://x" }, '"text", "image", and "audio"'],
      [{ type: "resource", resource: {} }, '"text", "image", and "audio"'],
      [{ type: "text" }, '"text" must be a string'],
      [{ type: "image", data: "aGk=" }, '"mimeType" must be a string'],
      [{ type: "image", data: 7, mimeType: "image/png" }, '"data" must be a string'],
      [{ type: "text", text: "x", annotations: {} }, "annotations"],
      [{ type: "text", text: "x", _meta: {} }, "_meta"],
      [{ type: "audio", data: "aGk=", mimeType: "audio/wav", extra: 1 }, '"extra"'],
    ];
    for (const [block, fragment] of invalid) {
      const sink = collector();
      expect(() => sink.accept(block), JSON.stringify(block)).toThrowError(
        new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      expect(sink.blocks).toHaveLength(0);
    }
  });

  it.each([
    "",
    "%%%invalid%%",
    "aGk",
    "aGk=\n",
    "a Gk=",
    "aGk===",
    "-_==",
    "AB==",
    "AAF=",
    "data:image/png;base64,aGk=",
  ])("INV-3: rejects malformed image base64 %j before collection", (data) => {
    const sink = collector();
    expect(() => sink.accept({ type: "image", data, mimeType: "image/png" })).toThrow(/strict base64/);
    expect(sink.blocks).toEqual([]);
    expect(sink.bytes).toBe(0);
  });

  it.each(["text/html", "image/svg+xml", "image/jpg", "IMAGE/PNG"])(
    "INV-3: refuses unsupported image MIME %s",
    (mimeType) => {
      const sink = collector();
      expect(() => sink.accept({ type: "image", data: "aGk=", mimeType })).toThrow(/image mimeType/);
      expect(sink.blocks).toEqual([]);
    },
  );

  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "INV-3: accepts supported image MIME %s with canonical base64",
    (mimeType) => {
      const sink = collector();
      sink.accept({ type: "image", data: "aGk=", mimeType });
      expect(sink.blocks).toEqual([{ type: "image", data: "aGk=", mimeType }]);
    },
  );

  it("accepts exactly the three block shapes", () => {
    const sink = collector();
    sink.accept({ type: "text", text: "t" });
    sink.accept({ type: "image", data: "aGk=", mimeType: "image/png" });
    sink.accept({ type: "audio", data: "aGk=", mimeType: "audio/wav" });
    expect(sink.blocks).toHaveLength(3);
    expect(sink.bytes).toBeGreaterThan(0);
  });
});

describe("EmitCollector budgets (M5)", () => {
  it("fails the crossing block on count, prior blocks intact", () => {
    const sink = new EmitCollector(10_000, 2);
    sink.accept({ type: "text", text: "one" });
    sink.accept({ type: "text", text: "two" });
    expect(() => sink.accept({ type: "text", text: "three" })).toThrowError(
      /block-count budget exceeded: 2 block\(s\) maximum, 0 blocks remaining; 9944 of 10000 serialized bytes remaining/,
    );
    expect(sink.blocks).toHaveLength(2);
  });

  it("fails the crossing block on bytes, naming the room remaining", () => {
    const small = { type: "text", text: "ok" };
    const smallSize = JSON.stringify(small).length;
    const sink = new EmitCollector(smallSize + 5, 10);
    sink.accept(small);
    expect(() => sink.accept({ type: "text", text: "x".repeat(100) })).toThrowError(
      new RegExp(`5 of ${smallSize + 5} remaining`),
    );
    expect(sink.blocks).toHaveLength(1);
    expect(sink.bytes).toBe(smallSize);
  });
  it("INV-3: native batches obey the block budget atomically", () => {
    const sink = new EmitCollector(10_000, 2);
    sink.accept({ type: "text", text: "prior" });
    const previousBytes = sink.bytes;
    expect(() =>
      sink.acceptNative([
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "resource_link", uri: "asset://badge", name: "badge" },
      ]),
    ).toThrow(/block-count budget exceeded/);
    expect(sink.blocks).toEqual([{ type: "text", text: "prior" }]);
    expect(sink.bytes).toBe(previousBytes);
  });
});

describe("connecta.emit provider (M7, M8)", () => {
  it("fails loudly when no collector is configured", async () => {
    const providers = await buildSandboxProviders(makeRegistry([calcConnector]), BASE, silentLogger);
    const emit = required(providers.find((p) => p.name === "connecta")?.fns.emit);
    await expect(emit({ type: "text", text: "x" })).rejects.toThrowError(/no emission collector/);
  });

  it("spends no host-call budget", async () => {
    const sink = new EmitCollector(10_000, 10);
    let terminalCode: string | undefined;
    const providers = await buildSandboxProviders(makeRegistry([calcConnector]), BASE, silentLogger, undefined, {
      maxHostCalls: 1,
      emitCollector: sink,
      onHostCallBudgetExceeded: (failure) => {
        terminalCode = failure.details.code;
      },
    });
    const fns = required(providers.find((p) => p.name === "connecta")).fns;
    const emit = required(fns.emit);
    const call = required(fns.call);
    await emit({ type: "text", text: "a" });
    await emit({ type: "text", text: "b" });
    // The single host call is still available after two emits…
    await expect(call("calc.add", { a: 1, b: 2 })).resolves.toEqual({ data: { sum: 3 }, format: "json" });
    // The next call ends the host run instead of rejecting into the guest.
    let settled = false;
    void call("calc.add", { a: 1, b: 2 }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(terminalCode).toBe("budget_exceeded");
    expect(sink.blocks).toHaveLength(2);
  });
});

describe("createExecuteTool delivery (M2, M3, M4, M10)", () => {
  it("appends emitted blocks after the envelope, in order", async () => {
    const handler = emitHandler(
      scriptedExecutor(async (fns) => {
        await required(fns.emit)({ type: "text", text: "caption" });
        await required(fns.emit)({
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
        });
        return { ok: true };
      }),
    );
    const out = await handler({ code: "ignored" });
    expect(out.isError).toBeUndefined();
    expect(out.content).toHaveLength(3);
    const envelope = JSON.parse(required(out.content[0]).text ?? "");
    expect(envelope).toEqual({
      result: { ok: true },
      emitted: 2,
      hostCalls: { attempted: 0, admitted: 0, succeeded: 0, failed: 0 },
    });
    expect(out.structuredContent).toEqual({
      result: { ok: true },
      emitted: 2,
      hostCalls: { attempted: 0, admitted: 0, succeeded: 0, failed: 0 },
    });
    expect(out.content[1]).toEqual({ type: "text", text: "caption" });
    expect(out.content[2]).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    });
  });

  it("a program that never emits produces today's exact response", async () => {
    const handler = emitHandler(scriptedExecutor(async () => "plain"));
    expect(await handler({ code: "ignored" })).toEqual(
      jsonResult({ result: "plain", hostCalls: { attempted: 0, admitted: 0, succeeded: 0, failed: 0 } }),
    );
  });

  it("honors configured budgets and falls back on invalid ones", async () => {
    const script = async (fns: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
      const out: Record<string, unknown> = { delivered: 0 };
      await required(fns.emit)({ type: "text", text: "one" });
      out.delivered = 1;
      try {
        await required(fns.emit)({ type: "text", text: "two" });
        out.delivered = 2;
      } catch (err) {
        out.refused = err instanceof Error ? err.message : String(err);
      }
      return out;
    };
    const capped = await emitHandler(scriptedExecutor(script), {
      maxEmittedBlocks: 1,
    })({ code: "ignored" });
    const cappedEnvelope = JSON.parse(required(capped.content[0]).text ?? "");
    expect(String(cappedEnvelope.result.refused)).toContain("block-count budget");
    expect(capped.content).toHaveLength(2);

    // Zero is not a budget; both knobs fall back to their defaults.
    const fallback = await emitHandler(scriptedExecutor(script), {
      maxEmittedBlocks: 0,
      maxEmittedBytes: Number.NaN,
    })({ code: "ignored" });
    const fallbackEnvelope = JSON.parse(required(fallback.content[0]).text ?? "");
    expect(fallbackEnvelope.result).toEqual({ delivered: 2 });
    expect(fallback.content).toHaveLength(3);
  });

  it("discards blocks on failure and says so, structured and plain", async () => {
    const failing = scriptedExecutor(async (fns) => {
      await required(fns.emit)({ type: "text", text: "doomed" });
      throw new Error("after emitting");
    });
    const plain = await emitHandler(failing)({ code: "ignored" });
    expect(plain.isError).toBe(true);
    expect(plain.content).toHaveLength(1);
    const plainText = required(plain.content[0]).text ?? "";
    expect(plainText).toContain("after emitting");
    expect(JSON.parse(plainText)).toMatchObject({ emittedDiscarded: 1 });
    expect(plainText).not.toContain("doomed");

    const structured = await emitHandler(failing)({
      code: "ignored",
      diagnostics: true,
    });
    expect(structured.isError).toBe(true);
    const envelope = JSON.parse(required(structured.content[0]).text ?? "");
    expect(envelope.emittedDiscarded).toBe(1);
    expect(envelope.error.code).toBe("program_error");
  });

  it("reports the emitted aggregate in diagnostics, numbers only", async () => {
    const handler = emitHandler(
      scriptedExecutor(async (fns) => {
        await required(fns.emit)({ type: "text", text: "measured" });
        return "done";
      }),
    );
    const out = await handler({ code: "ignored", diagnostics: true });
    const envelope = JSON.parse(required(out.content[0]).text ?? "");
    expect(envelope.diagnostics.emitted.count).toBe(1);
    expect(envelope.diagnostics.emitted.bytes).toBeGreaterThan(0);

    const quiet = await emitHandler(scriptedExecutor(async () => "done"))({
      code: "ignored",
      diagnostics: true,
    });
    const quietEnvelope = JSON.parse(required(quiet.content[0]).text ?? "");
    expect(quietEnvelope.diagnostics.emitted).toBeUndefined();
  });
});

describe("emit budget defaults", () => {
  it("default budgets fit the motivating case and nothing grander", () => {
    expect(EXECUTE_MAX_EMITTED_BYTES).toBe(4_000_000);
    expect(EXECUTE_MAX_EMITTED_BLOCKS).toBe(32);
  });
});
