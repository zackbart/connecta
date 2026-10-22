import { describe, expect, it, vi } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { InvocationService } from "../src/invocation.js";
import { createMetaTools } from "../src/meta-tools.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { BASE, registry, textOf } from "./fixtures/meta-tools.js";
import { activitySink, calcConnector, makeRegistry, required, silentLogger } from "./helpers.js";

/**
 * One connecta.result page, read the way a client does: a one-line JSON header,
 * a newline, and the raw page text.
 */
function pageOf(result: { content: { text: string }[] }): {
  offset: number;
  nextOffset?: number | undefined;
  totalBytes: number;
  text: string;
} {
  const whole = required(result.content[0]).text;
  const newline = whole.indexOf("\n");
  const header = JSON.parse(whole.slice(0, newline)) as {
    offset: number;
    totalBytes: number;
    hasMore: boolean;
    nextOffset?: number;
  };
  return {
    offset: header.offset,
    ...(header.hasMore ? { nextOffset: header.nextOffset } : {}),
    totalBytes: header.totalBytes,
    text: whole.slice(newline + 1),
  };
}

describe("call_tool", () => {
  it("JSON-wraps an api connector's return value", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({
      address: "calc.add",
      args: { a: 2, b: 3 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(required(result.content[0]).text)).toEqual({ sum: 5 });
  });

  it("keeps call_destructive_tool's reason out of the downstream arguments", async () => {
    const seen: unknown[] = [];
    const dangerous = api("danger", {
      tools: [
        {
          name: "erase",
          description: "Erase the thing",
          annotations: { destructiveHint: true, readOnlyHint: false },
          handler: (args: unknown) => {
            seen.push(args);
            return { erased: true };
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([dangerous]), BASE);

    await mt.callDestructiveTool({
      address: "danger.erase",
      args: { target: "duplicate" },
      reason: "The user asked to remove the duplicate they selected.",
    });

    // `reason` is context for the host's approval view and stops there. It is
    // not authority, and a connector must never see it as an input.
    expect(seen).toEqual([{ target: "duplicate" }]);
    expect(Object.keys(required(seen[0]) as object)).toEqual(["target"]);
  });

  it("INV-9: dispatches a transiently failing write exactly once", async () => {
    let calls = 0;
    const connector = api("once", {
      tools: [
        {
          name: "write",
          description: "A write whose failure could invite a retry",
          annotations: { readOnlyHint: false },
          handler: () => {
            calls++;
            throw new Error("temporary 503");
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const result = await mt.callDestructiveTool({
      address: "once.write",
      reason: "Perform the requested write once.",
      resultMode: "value",
    });
    expect(textOf(result)).toMatchObject({ ok: false, attempts: 1 });
    expect(calls).toBe(1);
  });

  it("schema-invalid args fail closed as invalid_args without reaching the handler", async () => {
    let calls = 0;
    const connector = api("strict", {
      tools: [
        {
          name: "page",
          description: "Read one page of values",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { page: { type: "integer" } },
            required: ["page"],
          },
          handler: () => {
            calls++;
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "strict.page",
        resultMode: "value",
        args: { page: "3" },
      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { code: string; retryable: boolean };
    };
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { code: "invalid_args", retryable: false },
    });
    expect(calls).toBe(0);
  });
});

// An API connector returning a result large enough to exercise paging.
const dataConnector: Connector = connectorWith({
  id: "data",
  kind: "api",
  description: "Data",
  tools: [
    {
      name: "big",
      description: "Return a large blob",
      annotations: { readOnlyHint: true },
    },
  ],
  call: async (name) => {
    if (name === "big") return { blob: "x".repeat(500) };
    throw new Error(`Unknown tool "${name}" on connector "data"`);
  },
});

describe("call_tool size guard + connecta.result", () => {
  it("replaces oversized value-mode data with a page handle", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector], { maxResultBytes: 100 }), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "data.big",
        resultMode: "value",
      }),
    ) as {
      ok: boolean;
      data: { truncated: boolean; resultId: string; totalBytes: number };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.data.truncated).toBe(true);
    expect(parsed.data.totalBytes).toBeGreaterThan(100);
    expect(parsed.data).toMatchObject({
      nextAction: {
        tool: "execute_code",
        arguments: {
          code: `async () => await connecta.result(${JSON.stringify(parsed.data.resultId)}, { offset: 0, maxBytes: 3829 })`,
        },
      },
    });
    let text = "";
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = pageOf(await mt.readResult({ id: parsed.data.resultId, offset, maxBytes: 1_000 }));
      expect(page.text.length).toBeLessThanOrEqual(100);
      text += page.text;
      offset = page.nextOffset;
    }
    expect(JSON.parse(text)).toEqual({ blob: "x".repeat(500) });
  });

  it("pages multi-byte content at a codepoint-splitting boundary byte-exactly", async () => {
    // "aa😀bb" — the emoji is 4 UTF-8 bytes, so a 4-byte page ending at byte 4
    // lands mid-codepoint. Reassembly must equal the original with no U+FFFD.
    const original = JSON.stringify({ v: "aa😀bb界🎉cc" });
    const conn: Connector = connectorWith({
      id: "mb",
      kind: "api",
      description: "Multibyte",
      tools: [
        {
          name: "get",
          description: "unicode",
          annotations: { readOnlyHint: true },
        },
      ],
      call: async () => JSON.parse(original),
    });
    // cap of 4 forces truncation and 4-byte pages that split codepoints.
    const mt = createMetaTools(makeRegistry([conn], { maxResultBytes: 4 }), BASE);
    const call = await mt.callTool({ address: "mb.get" });
    const lines = required(call.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[0])) as { resultId: string };

    const expected = JSON.stringify(JSON.parse(original));
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = pageOf(await mt.readResult({ id: notice.resultId, offset, maxBytes: 4 }));
      expect(page.text).not.toContain("�");
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(expected);
  });
});

// ASCII, so byte length == char length, and it JSON-encodes to one line.
const PAYLOAD = "x".repeat(500);
const FULL = JSON.stringify(PAYLOAD); // 502 bytes

/** An api connector returning PAYLOAD, optionally under its own byte cap. */
function capped(id: string, maxResultBytes?: number): Connector {
  return connectorWith({
    id,
    kind: "api",
    description: "Capped",
    ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
    tools: [
      {
        name: "big",
        description: "Return a large blob",
        annotations: { readOnlyHint: true },
      },
    ],
    call: async () => PAYLOAD,
  });
}

describe("per-connector maxResultBytes override", () => {
  interface Notice {
    truncated: boolean;
    resultId: string;
    totalBytes: number;
  }

  /** Split a guarded text result into its head and its truncation notice. */
  function truncation(result: { content: { text: string }[] }): {
    head: string;
    notice: Notice;
  } {
    const [notice, head] = required(result.content[0]).text.split("\n");
    return {
      head: required(head),
      notice: JSON.parse(required(notice)) as Notice,
    };
  }

  it.each([
    ["truncates at a connector cap lower than the global one", "tight", 100, 400, 100, true],
    ["keeps a result inline under a connector cap higher than the global one", "wide", 1_000, 100, null, false],
  ] as const)("%s", async (_name, id, override, deploymentCap, expectedHead, truncated) => {
    const mt = createMetaTools(
      makeRegistry([capped(id, override)], deploymentCap === undefined ? {} : { maxResultBytes: deploymentCap }),
      BASE,
    );
    const result = await mt.callTool({ address: `${id}.big` });
    if (!truncated) {
      expect(required(result.content[0]).text).toBe(FULL);
      return;
    }
    const guarded = truncation(result);
    expect(guarded.head).toBe(FULL.slice(0, required(expectedHead)));
    expect(guarded.notice.truncated).toBe(true);
    expect(guarded.notice.totalBytes).toBe(FULL.length);
  });
});

describe("maxResultBytes validation", () => {
  /** Caps that are accepted today but silently do something wrong (issue #32). */
  const BAD_CAPS = [0, 1.5, Number.NaN];

  /** Stash an oversized result and hand back its page id. */
  async function stash(): Promise<{
    mt: ReturnType<typeof createMetaTools>;
    resultId: string;
  }> {
    const mt = createMetaTools(makeRegistry([capped("c")], { maxResultBytes: 100 }), BASE);
    const call = await mt.callTool({ address: "c.big" });
    const notice = JSON.parse(required(required(call.content[0]).text.split("\n")[0])) as {
      resultId: string;
    };
    return { mt, resultId: notice.resultId };
  }

  it.each(BAD_CAPS)("rejects connecta.result maxBytes %s", async (maxBytes) => {
    const { mt, resultId } = await stash();
    const result = await mt.readResult({ id: resultId, maxBytes });
    expect(result.isError, `maxBytes ${String(maxBytes)}`).toBe(true);
    expect(required(result.content[0]).text).toContain("Invalid maxBytes");
  });

  it.each(BAD_CAPS)("INV-11: refuses connector override %s at construction", (override) => {
    expect(() => makeRegistry([capped("c", override)], { maxResultBytes: 400 })).toThrow(
      'Connector "c" maxResultBytes must be a whole number of bytes >= 1',
    );
  });
});

/** UTF-8 byte length, the unit every cap and offset in these suites is in. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("mcp-mode content size guard", () => {
  /** A kind:"mcp" connector whose one tool returns `content` verbatim. */
  function downstream(content: unknown[]): Connector {
    return connectorWith({
      id: "down",
      kind: "mcp",
      description: "Downstream MCP",
      tools: [
        {
          name: "fetch",
          description: "Return canned content",
          annotations: { readOnlyHint: true },
        },
      ],
      call: async () => ({ content }),
    });
  }

  function metaTools(content: unknown[], maxResultBytes?: number) {
    return createMetaTools(
      makeRegistry([downstream(content)], maxResultBytes !== undefined ? { maxResultBytes } : {}),
      BASE,
    );
  }

  /** What `call_tool` stashes and pages for an oversized mcp result. */
  function envelope(content: unknown[]): string {
    return JSON.stringify(content);
  }

  interface Notice {
    truncated: boolean;
    resultId: string;
    totalBytes: number;
  }

  it("measures the envelope it truncates, not just the text inside it", async () => {
    // 12 blocks of 20 characters: 240 bytes of text, but a 700+ byte envelope
    // once block wrappers, keys, quoting and indentation are counted. Pre-fix
    // the decision used the 240 while the head and totalBytes were cut from
    // the envelope, so a cap between the two returned everything inline and a
    // cap under both described a string it never compared against (issue #43).
    const content = Array.from({ length: 12 }, (_, i) => ({
      type: "text",
      text: `block-${i}`.padEnd(20, "x"),
    }));
    const full = envelope(content);
    const textOnly = content.reduce((n, b) => n + byteLength(b.text), 0);
    const cap = 300;
    expect(textOnly).toBeLessThan(cap);
    expect(byteLength(full)).toBeGreaterThan(cap);

    const result = await metaTools(content, cap).callTool({
      address: "down.fetch",
    });
    const lines = required(result.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[0])) as Notice;
    const head = lines.slice(1).join("\n");
    expect(notice.truncated).toBe(true);
    // One unit for the cap and totalBytes: the envelope. The preview is the
    // blocks' readable text, bounded by the same cap.
    expect(notice.totalBytes).toBe(byteLength(full));
    expect(head).toBe(
      content
        .map((b) => b.text)
        .join("\n")
        .slice(0, cap),
    );
    expect(byteLength(head)).toBeLessThanOrEqual(cap);
  });
});

describe("connecta.result offset validation and alignment", () => {
  // Stored as `"aa😀bb"` — byte 3 starts the 4-byte emoji, so bytes 4, 5 and 6
  // are inside a character and byte 3 is the boundary they belong to.
  const EMOJI_PAYLOAD = "aa😀bb";
  const EMOJI_FULL = JSON.stringify(EMOJI_PAYLOAD);
  const EMOJI_START = 3;

  async function stashEmoji(): Promise<{
    mt: ReturnType<typeof createMetaTools>;
    resultId: string;
  }> {
    const conn = api("mb", {
      description: "Multibyte",
      tools: [
        {
          name: "get",
          description: "unicode",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => EMOJI_PAYLOAD,
        },
      ],
    });
    // A cap of 9, one byte under the payload, stashes it whole; pages are
    // clamped to that cap, so it is also wide enough for the 100-byte requests
    // below to reach the end from any offset.
    const mt = createMetaTools(makeRegistry([conn], { maxResultBytes: 9 }), BASE);
    const call = await mt.callTool({ address: "mb.get" });
    const lines = required(call.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[0])) as { resultId: string };
    return { mt, resultId: notice.resultId };
  }

  it.each([-50, Number.NaN])("rejects in-process offset %s", async (offset) => {
    // The tier #32 chose to defend for maxBytes: MCP callers are stopped by the
    // registered schema, in-process callers of createMetaTools are not. Pre-fix
    // `offset: NaN` answered with `"offset": null`, empty text and no
    // nextOffset — the result silently vanished instead of erroring (issue #38).
    const { mt, resultId } = await stashEmoji();
    const result = await mt.readResult({ id: resultId, offset });
    expect(result.isError, `offset ${String(offset)}`).toBe(true);
    expect(required(result.content[0]).text).toContain("Invalid offset");
  });

  it.each([5])("aligns offset %s landing inside a character", async (requested) => {
    // Pre-fix these decoded the severed bytes as U+FFFD.
    const { mt, resultId } = await stashEmoji();
    const page = pageOf(await mt.readResult({ id: resultId, offset: requested, maxBytes: 100 }));
    expect(page.text, `offset ${requested}`).not.toContain("�");
    expect(page.offset, `offset ${requested}`).toBe(EMOJI_START);
    expect(page.text).toBe('😀bb"');
    expect(page.totalBytes).toBe(byteLength(EMOJI_FULL));
  });
});

describe("audit regressions", () => {
  it.each(["callDestructiveTool"] as const)("keeps %s successful when result storage fails", async (method) => {
    const store = memoryStorage();
    const storage = {
      ...store,
      set: vi.fn(async (key: string, value: string, opts?: { ttlSeconds?: number }) => {
        if (key.includes("result:")) throw new Error("KV PUT failed: 503 Service Temporarily Unavailable secret");
        await store.set(key, value, opts);
      }),
    };
    const warn = vi.fn();
    const call = vi.fn(async () => "x".repeat(4_000));
    const connector = connectorWith({
      id: "large",
      kind: "api",
      tools: [{ name: "read", annotations: { readOnlyHint: false } }],
      call,
    });
    const target = activitySink();
    const mt = createMetaTools(
      makeRegistry([connector], { storage, maxResultBytes: 1_000, logger: { ...silentLogger, warn } }),
      BASE,
      { readOnly: false, activity: target.activity },
    );
    for (const resultMode of ["mcp", "value"] as const) {
      const result = await mt[method]({ address: "large.read", resultMode });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).toContain("Paging is unavailable");
      expect(JSON.stringify(result)).not.toContain("resultId");
      expect(JSON.stringify(result)).not.toContain("KV PUT");
      if (resultMode === "value") expect(textOf(result)).toMatchObject({ ok: true });
    }
    expect(call).toHaveBeenCalledTimes(2);
    expect(target.events).toHaveLength(2);
    expect(target.events.every((event) => event.outcome === "success")).toBe(true);
    expect(warn.mock.calls.filter(([line]) => line === "[connecta] result paging unavailable")).toHaveLength(2);
  });

  it("never retries result processing after a completed downstream call", async () => {
    const reg = makeRegistry([calcConnector]);
    const outcome = await new InvocationService(reg, new CatalogService(reg, BASE)).invoke(
      "calc.add",
      { a: 1, b: 2 },
      {
        source: "call_tool",
        processResult: () => {
          throw new Error("503 temporarily unavailable secret");
        },
      },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "result_processing_failed", retryable: false } });
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });

  it("guards synthesized structured text and preserves existing text", async () => {
    let nativeText = false;
    const connector = connectorWith({
      id: "remote",
      kind: "mcp",
      tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      call: async () => ({
        content: nativeText
          ? [{ type: "text", text: "native" }]
          : [{ type: "image", data: "AA==", mimeType: "image/png" }],
        structuredContent: { large: "x".repeat(4_000) },
      }),
    });
    const mt = createMetaTools(makeRegistry([connector], { maxResultBytes: 1_000 }), BASE);
    const result = await mt.callTool({ address: "remote.read" });
    expect(JSON.stringify(result)).toContain("resultId");
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
    nativeText = true;
    expect((await mt.callTool({ address: "remote.read" })).content).toEqual([{ type: "text", text: "native" }]);
  });

  it.each(["result", "authorization", "search"])("bounds caller-authored %s names in refusals", async (kind) => {
    const mt = createMetaTools(makeRegistry([calcConnector], { maxResultBytes: 1_000 }), BASE);
    const huge = "x".repeat(50_000);
    const result = await (kind === "result"
      ? mt.readResult({ id: huge })
      : kind === "authorization"
        ? mt.authorizeConnector({ connector: huge })
        : mt.searchTools({ query: "read", connector: huge }));
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(1_000);
    expect(result.isError).toBe(true);
  });

  it.each(["admission", "connector"])("releases the permit when the deadline expires during %s", async (stage) => {
    vi.useFakeTimers();
    try {
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const call = vi.fn(() => {
        enter();
        return new Promise(() => {});
      });
      const connector = connectorWith({
        id: "limited",
        kind: "api",
        callAdmission: { rules: [{ maxConcurrency: 1 }] },
        tools: [{ name: "read", annotations: { readOnlyHint: true } }],
        call,
      });
      const reg = makeRegistry([connector]);
      const held = stage === "admission" ? await reg.admitCall("limited", { toolName: "read", args: {} }) : undefined;
      if (stage === "admission") {
        const admit = reg.admitCall.bind(reg);
        vi.spyOn(reg, "admitCall").mockImplementation((...args) => {
          const pendingPermit = admit(...args);
          enter();
          return pendingPermit;
        });
      }
      const pending = createMetaTools(reg, BASE).callTool({
        address: "limited.read",
        timeoutMs: 100,
        resultMode: "value",
      });
      await entered;
      await vi.advanceTimersByTimeAsync(100);
      expect(textOf(await pending)).toMatchObject({
        ok: false,
        error: { code: "timeout" },
      });
      held?.release();
      expect(reg.callAdmissionSnapshot().limited).toMatchObject({
        active: 0,
        queued: 0,
      });
      expect(call).toHaveBeenCalledTimes(stage === "admission" ? 0 : 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bounded result stash", () => {
  const notice = (result: { content: { text: string }[] }) =>
    JSON.parse(required(required(result.content[0]).text.split("\n")[0]));

  it.each([{ maxStashEntries: 1 }])(
    "reserves capacity across subjects before concurrent writes finish: %j",
    async (results) => {
      const storage = memoryStorage();
      let entered!: () => void;
      let release!: () => void;
      const writing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const root = new Registry([capped("large", 100)], {
        logger: silentLogger,
        results,
        storage: {
          ...storage,
          async set(key, value, options) {
            if (key.startsWith("subject:a:result:")) {
              entered();
              await gate;
            }
            await storage.set(key, value, options);
          },
        },
      });
      const first = createMetaTools(root.scoped({ connectorIds: "all", subjectKey: "a" }), BASE).callTool({
        address: "large.big",
      });
      await writing;
      try {
        const second = await createMetaTools(root.scoped({ connectorIds: "all", subjectKey: "b" }), BASE).callTool({
          address: "large.big",
        });
        expect(notice(second)).not.toHaveProperty("resultId");
      } finally {
        release();
      }
      expect(notice(await first)).toHaveProperty("resultId");
      expect(notice(await createMetaTools(root, BASE).callTool({ address: "large.big" }))).not.toHaveProperty(
        "resultId",
      );
    },
  );

  it.each([
    { case: "outlasts its deadline", delayMs: 25_000, chunks: ["h", "a", "b", "c"], ttlSeconds: 60 },
    { case: "exceeds the 30-second write budget", delayMs: 31_000, chunks: ["h"], ttlSeconds: 900 },
  ])("fails a stash that $case and releases its charge", async ({ delayMs, chunks, ttlSeconds }) => {
    let clock = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const inner = memoryStorage();
    const root = new Registry([], {
      logger: silentLogger,
      results: { maxStashEntries: 1 },

      storage: {
        ...inner,
        async set(key, value, options) {
          clock += delayMs;
          await inner.set(key, value, options);
        },
      },
    });
    try {
      expect(await root.stashResult("slow", chunks, ttlSeconds)).toBe(false);
      expect(await inner.list("results:")).toEqual([]);
      expect(await inner.get("result-stash:v1:ledger")).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("books every simultaneous claim the ledger has room for, and refuses only past capacity", async () => {
    const storage = memoryStorage();
    const isolates = Array.from(
      { length: 5 },
      () =>
        new Registry([], {
          logger: silentLogger,
          results: { maxStashEntries: 64 },

          storage,
        }),
    );
    const accepted = await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        isolates[index % isolates.length]!.stashResult(`claim-${index}`, ["x"], 900),
      ),
    );
    expect(accepted.filter(Boolean)).toHaveLength(64);
    expect(JSON.parse((await storage.get("result-stash:v1:ledger")) ?? "null").entries).toHaveLength(64);
    expect(await storage.list("results:result:")).toHaveLength(64);
  });

  it("INV-7: retains a rejected write's finite charge even after successful deletion", async () => {
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const storage = memoryStorage();
    let failWrite = true;
    let failDelete = true;
    const root = new Registry([capped("large", 100)], {
      logger: silentLogger,
      results: { maxStashEntries: 1 },
      storage: {
        ...storage,
        async set(key, value, options) {
          await storage.set(key, value, options);
          if (key.includes("result:") && failWrite) {
            failWrite = false;
            throw new Error("write failed after persisting");
          }
        },
        async delete(key) {
          if (key.includes("result:") && failDelete) throw new Error("delete unavailable");
          await storage.delete(key);
        },
      },
    });
    const call = () => createMetaTools(root, BASE).callTool({ address: "large.big" });
    // The write persisted, then failed, and its cleanup failed too: the
    // charge stays booked, so the bound still covers the orphaned bytes.
    expect(notice(await call())).not.toHaveProperty("resultId");
    expect(await storage.list("results:result:")).toHaveLength(1);
    expect(notice(await call())).not.toHaveProperty("resultId");
    // With deletion working, an unconfirmed write still holds its reservation.
    failDelete = false;
    failWrite = true;
    await storage.delete("result-stash:v1:ledger");
    for (const key of await storage.list("results:")) await storage.delete(key);
    expect(notice(await call())).not.toHaveProperty("resultId");
    expect(await storage.list("results:result:")).toEqual([]);
    expect(notice(await call())).not.toHaveProperty("resultId");
    clock += 930_001;
    expect(notice(await call())).toHaveProperty("resultId");
    now.mockRestore();
  });

  // One page, two results whose sizes differ by a factor of four. Counting the
  // characters storage hands back is structural: it fails if a page's read grows
  // with the stash rather than with the page, however fast the machine is.
  it("reads the same bytes for one page whatever the stored result's size", async () => {
    const pageRead = async (repeats: number) => {
      // Ten UTF-8 bytes per repeat, plus the two quotes JSON adds around it.
      const payload = "aé界😀".repeat(repeats);
      const inner = memoryStorage();
      let chars = 0;
      const storage = {
        ...inner,
        async get(key: string) {
          const value = await inner.get(key);
          chars += value?.length ?? 0;
          return value;
        },
      };
      const connector = connectorWith({
        id: "large",
        kind: "api",
        tools: [{ name: "read", annotations: { readOnlyHint: true } }],
        call: async () => payload,
      });
      const root = makeRegistry([connector], { maxResultBytes: 100, storage });
      const id = notice(await createMetaTools(root, BASE).callTool({ address: "large.read" })).resultId;
      // Chunks widen rather than multiply past a point, so no result turns into
      // an unbounded pile of keys — and of writes — on the way in.
      expect((await inner.list!("results:result:")).length).toBeLessThanOrEqual(33);
      chars = 0;
      // One byte past JSON's opening quote plus 10,000 whole repeats: a page
      // deep inside both results, at the same byte, from a different chunk index.
      const page = pageOf(await createMetaTools(root, BASE).readResult({ id, offset: 100_001, maxBytes: 1024 }));
      expect(page.totalBytes).toBe(repeats * 10 + 2);
      expect(page.text.startsWith("aé界😀")).toBe(true);
      expect(page.text).not.toContain("�");
      return { chars, text: page.text };
    };
    const small = await pageRead(30_000); // 300 KB stored
    const large = await pageRead(120_000); // 1.2 MB stored, same page
    expect(large.text).toBe(small.text);
    // Identical but for the decimal digits `totalBytes` adds to the header, and
    // a couple of chunks rather than the megabyte behind them.
    expect(large.chars - small.chars).toBeLessThan(8);
    expect(large.chars).toBeLessThan(200_000);
  });

  it("INV-3 INV-4: refuses pre-binding stashes after an upgrade", async () => {
    const stashed = JSON.stringify("aé界😀".repeat(400));
    const bytes = new TextEncoder().encode(stashed);
    const storage = memoryStorage();
    await storage.set(
      "results:result:inline",
      `connecta-result-v1:${bytes.length}:${btoa(String.fromCharCode(...bytes))}`,
    );
    await storage.set("results:result:raw", stashed);
    const mt = createMetaTools(makeRegistry([calcConnector], { storage }), BASE);
    for (const id of ["inline", "raw"]) {
      const page = await mt.readResult({ id, offset: 0, maxBytes: 777 });
      expect(page.isError).toBe(true);
      expect(JSON.stringify(page)).not.toContain(stashed);
    }
  });
});

describe("truncated results lead with their connecta.result handle", () => {
  // JSON lines: quote-heavy, so a serialized content envelope would escape
  // every one of them and a preview cut from it would read `\"ts\":…`.
  const JSON_LINES = Array.from({ length: 400 }, (_, i) =>
    JSON.stringify({
      ts: `2026-09-16T00:${String(i % 60).padStart(2, "0")}:00Z`,
      actor: `user${i}@example.com`,
      action: "login",
    }),
  ).join("\n");

  /** A kind:"mcp" connector returning `content`, read-only or write-capable. */
  function downstream(content: unknown[], readOnly: boolean): Connector {
    return connectorWith({
      id: "down",
      kind: "mcp",
      tools: [{ name: "run", annotations: { readOnlyHint: readOnly } }],
      call: async () => ({ content }),
    });
  }

  interface LeadingNotice {
    truncated: true;
    resultId: string;
    totalBytes: number;
    nextOffset: number;
    nextAction: { tool: string; arguments: { code: string } };
    hint: string;
  }

  /** The first line of a truncated text result is its notice; the rest is the preview. */
  function lead(result: { content: { text: string }[] }): { notice: LeadingNotice; preview: string } {
    expect(result.content).toHaveLength(1);
    const text = required(result.content[0]).text;
    const newline = text.indexOf("\n");
    expect(newline).toBeGreaterThan(0);
    return {
      notice: JSON.parse(text.slice(0, newline)) as LeadingNotice,
      preview: text.slice(newline + 1),
    };
  }

  it.each(["api-value", "mcp-blocks"] as const)(
    "INV-2 INV-9: a read-only endpoint refuses a %s write before dispatch, leaving nothing to page",
    async (mode) => {
      const store = memoryStorage();
      const stashKeys: string[] = [];
      const storage = {
        ...store,
        set: async (key: string, value: string, options?: { ttlSeconds?: number }) => {
          if (key.includes("result:") || key.includes("result-stash:")) stashKeys.push(key);
          await store.set(key, value, options);
        },
      };
      const { activity, events } = activitySink();
      let calls = 0;
      const connector = connectorWith({
        id: "down",
        kind: mode.startsWith("mcp") ? "mcp" : "api",
        tools: [{ name: "run", annotations: { readOnlyHint: false } }],
        call: async () => {
          calls++;
          return mode === "mcp-blocks"
            ? { content: [{ type: "image", mimeType: "image/png", data: "a".repeat(3000) }] }
            : mode.startsWith("mcp")
              ? { content: [{ type: "text", text: JSON_LINES }] }
              : JSON_LINES;
        },
      });
      const mt = createMetaTools(makeRegistry([connector], { storage, maxResultBytes: 1000 }), BASE, {
        readOnly: true,
        activity,
      });
      const result = await mt.callDestructiveTool({
        address: "down.run",
        resultMode: mode.endsWith("value") ? "value" : "mcp",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "read_only_endpoint", retryable: false } });
      expect(JSON.stringify(result)).not.toContain("connecta.result");
      expect(JSON.stringify(result)).not.toContain("call_destructive_tool");
      expect(stashKeys).toEqual([]);
      expect(calls).toBe(0);
      expect(events).toMatchObject([{ outcome: "error", errorCode: "read_only_endpoint" }]);
    },
  );

  it.each([["callDestructiveTool", false]] as const)(
    "keeps the %s handle inside what a cutting client still shows",
    async (method, readOnly) => {
      // Claude Code replaces an oversized MCP result with its first 2,000
      // characters of `JSON.stringify(content, null, 2)`. A tail notice never
      // survives that; a leading one must.
      const mt = createMetaTools(
        makeRegistry([downstream([{ type: "text", text: JSON_LINES }], readOnly)], { maxResultBytes: 10_000 }),
        BASE,
        { readOnly: false },
      );
      const result = await mt[method]({ address: "down.run" });
      const { notice } = lead(result);
      const shown = JSON.stringify(result.content, null, 2).slice(0, 2_000);
      expect(shown).toContain(notice.resultId);
      expect(shown).toContain("connecta.result");
      expect(shown).toContain(String(notice.totalBytes));
    },
  );

  it("tells a write's caller that the call already ran and must not be repeated", async () => {
    const mt = createMetaTools(
      makeRegistry([downstream([{ type: "text", text: JSON_LINES }], false)], { maxResultBytes: 1_000 }),
      BASE,
      { readOnly: false },
    );
    const { notice } = lead(await mt.callDestructiveTool({ address: "down.run", reason: "export" }));
    expect(notice.hint).toMatch(/already ran/i);
    expect(notice.hint).toMatch(/do not (call|repeat|run)/i);
    expect(notice.hint).toContain("connecta.result");
    const value = textOf(
      await mt.callDestructiveTool({ address: "down.run", reason: "export", resultMode: "value" }),
    ) as { data: LeadingNotice };
    expect(value.data.hint).toMatch(/already ran/i);

    const read = createMetaTools(
      makeRegistry([downstream([{ type: "text", text: JSON_LINES }], true)], { maxResultBytes: 1_000 }),
      BASE,
      { readOnly: false },
    );
    const { notice: readNotice } = lead(await read.callTool({ address: "down.run" }));
    expect(readNotice.hint).not.toMatch(/already ran/i);
    expect(readNotice.hint).toContain("connecta.result");
  });
});

describe("connecta.result pages raw text, clamped to the result's cap", () => {
  const LINES = Array.from({ length: 300 }, (_, i) =>
    JSON.stringify({
      ts: `2026-09-16T00:00:${String(i % 60).padStart(2, "0")}Z`,
      actor: `user${i}@example.com`,
      note: 'says "hi"',
    }),
  ).join("\n");

  function mcpText(id: string, content: unknown[], maxResultBytes?: number): Connector {
    return connectorWith({
      id,
      kind: "mcp",
      ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
      tools: [{ name: "run", annotations: { readOnlyHint: true } }],
      call: async () => ({ content }),
    });
  }

  interface PageHeader {
    resultId: string;
    offset: number;
    bytes: number;
    totalBytes: number;
    hasMore: boolean;
    nextOffset?: number;
  }

  /** A page is one text block: a one-line JSON header, a newline, the raw text. */
  function rawPage(result: { content: { text: string }[]; isError?: boolean }): {
    header: PageHeader;
    body: string;
    whole: string;
  } {
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const whole = required(result.content[0]).text;
    const newline = whole.indexOf("\n");
    expect(newline).toBeGreaterThan(0);
    return { header: JSON.parse(whole.slice(0, newline)) as PageHeader, body: whole.slice(newline + 1), whole };
  }

  async function truncatedId(
    mt: ReturnType<typeof createMetaTools>,
    address: string,
  ): Promise<{ id: string; next: number }> {
    const text = required((await mt.callTool({ address })).content[0]).text;
    const notice = JSON.parse(text.slice(0, text.indexOf("\n"))) as { resultId: string; nextOffset: number };
    return { id: notice.resultId, next: notice.nextOffset };
  }

  it("returns a header line then the raw page text, never JSON-escaped", async () => {
    const mt = createMetaTools(
      makeRegistry([mcpText("down", [{ type: "text", text: LINES }])], { maxResultBytes: 1_000 }),
      BASE,
    );
    const { id, next } = await truncatedId(mt, "down.run");
    const { header, body } = rawPage(await mt.readResult({ id, offset: next }));
    expect(body).toBe(LINES.slice(1_000, 2_000));
    expect(body).not.toContain('\\"ts\\"');
    expect(header).toEqual({
      resultId: id,
      offset: 1_000,
      bytes: 1_000,
      totalBytes: byteLength(LINES),
      hasMore: true,
      nextOffset: 2_000,
    });
  });

  it("reports the last page with hasMore false and no next action", async () => {
    const mt = createMetaTools(
      makeRegistry([mcpText("down", [{ type: "text", text: LINES }])], { maxResultBytes: 1_000 }),
      BASE,
    );
    const { id } = await truncatedId(mt, "down.run");
    const total = byteLength(LINES);
    const { header, body } = rawPage(await mt.readResult({ id, offset: total - 10 }));
    expect(body).toBe(LINES.slice(-10));
    expect(header).toMatchObject({ offset: total - 10, bytes: 10, totalBytes: total, hasMore: false });
    expect(header).not.toHaveProperty("nextAction");
  });

  it("pages at the connector's own cap, not the deployment's", async () => {
    const mt = createMetaTools(
      makeRegistry([mcpText("wide", [{ type: "text", text: LINES }], 3_000)], { maxResultBytes: 1_000 }),
      BASE,
    );
    const { id, next } = await truncatedId(mt, "wide.run");
    expect(next).toBe(3_000);
    for (const maxBytes of [undefined, 9_999]) {
      const { header } = rawPage(await mt.readResult({ id, offset: next, ...(maxBytes ? { maxBytes } : {}) }));
      expect(header.bytes, `maxBytes ${String(maxBytes)}`).toBe(3_000);
    }
  });

  it.each(["value"] as const)(
    "bounds an unpageable %s-mode truncation by the cap plus a small header",
    async (resultMode) => {
      const store = memoryStorage();
      const storage = {
        ...store,
        set: async (key: string, value: string, opts?: { ttlSeconds?: number }) => {
          if (key.includes("result:")) throw new Error("stash down");
          await store.set(key, value, opts);
        },
      };
      const cap = 1_000;
      // Quote-heavy JSON, so a preview escaped into value mode's JSON envelope
      // would grow well past the cap if it were cut at `cap` bytes before escaping.
      const connector = connectorWith({
        id: "api",
        kind: "api",
        tools: [{ name: "read", annotations: { readOnlyHint: true } }],
        call: async () => LINES,
      });
      const mt = createMetaTools(makeRegistry([connector], { storage, maxResultBytes: cap }), BASE);
      const result = await mt.callTool({ address: "api.read", resultMode });
      expect(JSON.stringify(result)).toContain("Paging is unavailable");
      expect(byteLength(required(result.content[0]).text)).toBeLessThanOrEqual(cap + 400);
    },
  );

  it("INV-3 INV-4: refuses an entry stashed before authority was recorded", async () => {
    const stashed = LINES.slice(0, 3_000);
    const bytes = new TextEncoder().encode(stashed);
    const storage = memoryStorage();
    await storage.set(
      "results:result:old",
      `connecta-result-v2:${bytes.length}:49152:${btoa(String.fromCharCode(...bytes))}`,
    );
    const mt = createMetaTools(makeRegistry([calcConnector], { storage, maxResultBytes: 1_000 }), BASE);
    const page = await mt.readResult({ id: "old", offset: 0, maxBytes: 5_000 });
    expect(page.isError).toBe(true);
    expect(JSON.stringify(page)).not.toContain(stashed);
  });
});
