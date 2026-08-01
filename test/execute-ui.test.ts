// The host side of the rendered-output channel (design record U1–U11): strict
// payload validation, one payload per run, the shared byte aggregate, delivery
// in result `_meta`, the discard report, and the byte-for-byte promise for
// programs that never call it. The cross-executor arm lives in the guest API
// contract cases, which run the same programs on QuickJS and the Dynamic
// Worker; the shell and its wiring are checked in test/server.test.ts.

import { describe, expect, it } from "vitest";
import {
  MCP_APPS_EXTENSION,
  PROGRAM_UI_META_KEY,
  PROGRAM_UI_MIME_TYPE,
  PROGRAM_UI_RESOURCE_URI,
  PROGRAM_UI_SHELL_HTML,
} from "../src/apps-shell.js";
import {
  buildSandboxProviders,
  createExecuteTool,
  EmitCollector,
} from "../src/execute.js";
import { jsonResult } from "../src/meta-tools.js";
import type { Executor, ExecutorProvider } from "../src/types.js";
import { calcConnector, makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

/**
 * Runs a closure against the connecta provider fns the way a bridged program
 * would: a return value becomes `result`, an uncaught throw becomes the bare
 * `error` message every executor reduces one to (E1).
 */
function scriptedExecutor(
  run: (
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
  ) => Promise<unknown>,
): Executor {
  return {
    async execute(_code, providers: ExecutorProvider[]) {
      const connecta = providers.find((p) => p.name === "connecta");
      if (!connecta) throw new Error("no connecta provider");
      try {
        return { result: await run(connecta.fns) };
      } catch (err) {
        return {
          result: undefined,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

function uiHandler(
  executor: Executor,
  config: Parameters<typeof createExecuteTool>[5] = {},
) {
  return createExecuteTool(
    makeRegistry([calcConnector]),
    BASE,
    executor,
    silentLogger,
    undefined,
    config,
  );
}

function envelopeOf(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(required(result.content[0]).text ?? "") as Record<
    string,
    unknown
  >;
}

const VIEW = "<!doctype html><p>a rendered view</p>";

/** HTML5 elements that never take a closing tag. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);
/** Elements whose content is text, not markup — a `<` inside is not a tag. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

/**
 * A stack-based walk over the shell's tag stream, standing in for a real HTML5
 * validator. The repo has no HTML parser among its devDependencies and this
 * assertion is not worth acquiring one: the published surface is what
 * dependencies are guarded for, and a parser bought for a hundred-line
 * build-time constant would be a permanent cost for a one-file check. So it
 * catches what actually breaks a shell edit — an element left open, a
 * mismatched close, markup after `</html>` — and stops well short of
 * conformance. Doctype and comments are skipped (neither starts with a name),
 * and raw-text elements are jumped over so JS and CSS cannot look like tags.
 */
function walkTags(source: string): {
  elements: Array<{ name: string; attrs: string }>;
  unclosed: string[];
} {
  const elements: Array<{ name: string; attrs: string }> = [];
  const stack: string[] = [];
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(source)) !== null) {
    const closing = match[1] === "/";
    const name = required(match[2]).toLowerCase();
    const attrs = match[3] ?? "";
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        throw new Error(
          `shell HTML closes </${name}> while ${open ? `<${open}>` : "nothing"} is open`,
        );
      }
      continue;
    }
    elements.push({ name, attrs: attrs.trim() });
    if (VOID_ELEMENTS.has(name) || attrs.trimEnd().endsWith("/")) continue;
    stack.push(name);
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const end = source.indexOf(`</${name}`, tag.lastIndex);
      if (end === -1) throw new Error(`shell HTML never closes <${name}>`);
      tag.lastIndex = end;
    }
  }
  return { elements, unclosed: stack };
}

/**
 * The params the shell actually puts on the wire for `ui/initialize`, read out
 * of the shell source rather than grepped for. A test that only checks the
 * method name appears would pass happily while a conforming host rejected the
 * request as schema-invalid and the handshake never completed.
 */
function shellInitializeParams(): Record<string, unknown> {
  const send = PROGRAM_UI_SHELL_HTML.indexOf('method: "ui/initialize"');
  expect(send, "the shell sends ui/initialize").toBeGreaterThan(-1);
  const open = PROGRAM_UI_SHELL_HTML.indexOf(
    "{",
    PROGRAM_UI_SHELL_HTML.indexOf("params:", send),
  );
  // Lift the balanced object literal, then quote its bare keys. The literal is
  // hand-written JS with double-quoted strings and no trailing commas, which
  // is the only dialect this needs to survive.
  let depth = 0;
  let inString = false;
  let literal = "";
  for (let i = open; i < PROGRAM_UI_SHELL_HTML.length; i++) {
    const ch = required(PROGRAM_UI_SHELL_HTML[i]);
    literal += ch;
    if (inString) {
      if (ch === "\\") literal += required(PROGRAM_UI_SHELL_HTML[++i]);
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) break;
  }
  return JSON.parse(
    literal.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3'),
  ) as Record<string, unknown>;
}

describe("EmitCollector UI validation (U1)", () => {
  const collector = () => new EmitCollector(10_000, 10);

  it("rejects every shape that is not a non-empty string, accepting nothing", () => {
    const invalid: Array<[unknown, string]> = [
      ["", "an empty string"],
      [undefined, "undefined"],
      [null, "null"],
      [7, "a number"],
      [true, "a boolean"],
      [["<p>x</p>"], "an array"],
      // An options bag and an MCP block object are simply non-strings.
      [{ html: VIEW }, "an object"],
      [{ html: VIEW, title: "report" }, "an object"],
      [{ type: "text", text: VIEW }, "an object"],
      [{ type: "resource", resource: { uri: "ui://lure" } }, "an object"],
    ];
    for (const [payload, fragment] of invalid) {
      const sink = collector();
      expect(() => sink.acceptUi(payload), JSON.stringify(payload)).toThrowError(
        /connecta\.ui accepts exactly one argument/,
      );
      expect(() => sink.acceptUi(payload)).toThrowError(
        new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      expect(sink.ui).toBeUndefined();
      expect(sink.bytes).toBe(0);
    }
  });

  it("accepts one non-empty HTML string", () => {
    const sink = collector();
    sink.acceptUi(VIEW);
    expect(sink.ui).toEqual({ html: VIEW });
    expect(sink.bytes).toBe(JSON.stringify({ html: VIEW }).length);
  });
});

describe("EmitCollector UI multiplicity and budget (U2, U4)", () => {
  it("refuses a second payload, naming the constraint; the first stands", () => {
    const sink = new EmitCollector(10_000, 10);
    sink.acceptUi(VIEW);
    expect(() => sink.acceptUi("<p>second</p>")).toThrowError(
      /at most one payload per run/,
    );
    expect(sink.ui).toEqual({ html: VIEW });
  });

  it("reports the multiplicity constraint even when the second call is junk", () => {
    // Multiplicity is checked before shape. A program whose second payload is
    // also malformed has exactly one problem worth naming — that there is a
    // second payload — and a complaint about its type would send the author
    // to fix the wrong thing.
    for (const second of [undefined, null, 7, "", { html: VIEW }]) {
      const sink = new EmitCollector(10_000, 10);
      sink.acceptUi(VIEW);
      expect(() => sink.acceptUi(second), JSON.stringify(second)).toThrowError(
        /at most one payload per run/,
      );
      expect(sink.ui).toEqual({ html: VIEW });
    }
  });

  it("spends the emit byte aggregate, and no block count", () => {
    const sink = new EmitCollector(10_000, 1);
    sink.acceptUi(VIEW);
    const uiBytes = JSON.stringify({ html: VIEW }).length;
    expect(sink.bytes).toBe(uiBytes);
    // The single block budget is untouched by the payload — it is not a block.
    sink.accept({ type: "text", text: "caption" });
    expect(sink.blocks).toHaveLength(1);
    expect(sink.bytes).toBe(
      uiBytes + JSON.stringify({ type: "text", text: "caption" }).length,
    );
  });

  it("emit and ui cross one shared byte budget, in either order", () => {
    const block = { type: "text", text: "ok" };
    const blockBytes = JSON.stringify(block).length;
    const uiOverflow = new EmitCollector(blockBytes + 5, 10);
    uiOverflow.accept(block);
    expect(() => uiOverflow.acceptUi(VIEW)).toThrowError(
      new RegExp(`connecta\\.ui byte budget exceeded.*5 of ${blockBytes + 5} remaining`),
    );
    expect(uiOverflow.ui).toBeUndefined();
    expect(uiOverflow.bytes).toBe(blockBytes);

    const uiBytes = JSON.stringify({ html: VIEW }).length;
    const emitOverflow = new EmitCollector(uiBytes + 5, 10);
    emitOverflow.acceptUi(VIEW);
    expect(() => emitOverflow.accept(block)).toThrowError(
      new RegExp(`connecta\\.emit byte budget exceeded.*5 of ${uiBytes + 5} remaining`),
    );
    expect(emitOverflow.blocks).toHaveLength(0);
  });
});

describe("connecta.ui provider (U4, U7)", () => {
  it("fails loudly when no collector is configured", async () => {
    const providers = await buildSandboxProviders(
      makeRegistry([calcConnector]),
      BASE,
      silentLogger,
    );
    const ui = required(providers.find((p) => p.name === "connecta")?.fns.ui);
    await expect(ui(VIEW)).rejects.toThrowError(/no emission collector/);
  });

  it("spends no host-call budget", async () => {
    const sink = new EmitCollector(10_000, 10);
    const providers = await buildSandboxProviders(
      makeRegistry([calcConnector]),
      BASE,
      silentLogger,
      undefined,
      { maxHostCalls: 1, emitCollector: sink },
    );
    const fns = required(providers.find((p) => p.name === "connecta")).fns;
    await required(fns.ui)(VIEW);
    await expect(required(fns.call)("calc.add", { a: 1, b: 2 })).resolves.toEqual(
      { sum: 3 },
    );
    await expect(
      required(fns.call)("calc.add", { a: 1, b: 2 }),
    ).rejects.toThrowError(/host-call budget/);
    expect(sink.ui).toEqual({ html: VIEW });
  });
});

describe("createExecuteTool UI delivery (U3, U8, U9)", () => {
  it("delivers the payload in _meta and marks the envelope", async () => {
    const handler = uiHandler(
      scriptedExecutor(async (fns) => {
        await required(fns.ui)(VIEW);
        return { ok: true };
      }),
    );
    const out = await handler({ code: "ignored" });
    expect(out.isError).toBeUndefined();
    // The payload rides _meta only — the content array is the envelope alone.
    expect(out.content).toHaveLength(1);
    expect(out._meta).toEqual({ [PROGRAM_UI_META_KEY]: { html: VIEW } });
    expect(envelopeOf(out)).toEqual({ result: { ok: true }, ui: true });
    expect(out.structuredContent).toEqual({ result: { ok: true }, ui: true });
    // The bytes never reach the model's channel.
    expect(required(out.content[0]).text).not.toContain("a rendered view");
  });

  it("coexists with emitted blocks in one response", async () => {
    const handler = uiHandler(
      scriptedExecutor(async (fns) => {
        await required(fns.emit)({ type: "text", text: "caption" });
        await required(fns.ui)(VIEW);
        return "both";
      }),
    );
    const out = await handler({ code: "ignored" });
    expect(envelopeOf(out)).toEqual({ result: "both", emitted: 1, ui: true });
    expect(out.content).toHaveLength(2);
    expect(out._meta).toEqual({ [PROGRAM_UI_META_KEY]: { html: VIEW } });
  });

  it("a program that never calls connecta.ui produces today's exact response", async () => {
    const handler = uiHandler(scriptedExecutor(async () => "plain"));
    const out = await handler({ code: "ignored" });
    expect(out).toEqual(jsonResult({ result: "plain" }));
    expect(out._meta).toBeUndefined();
  });

  it("discards the payload on failure and says so, structured and plain", async () => {
    const failing = scriptedExecutor(async (fns) => {
      await required(fns.ui)(VIEW);
      throw new Error("after rendering");
    });
    const plain = await uiHandler(failing)({ code: "ignored" });
    expect(plain.isError).toBe(true);
    expect(plain._meta).toBeUndefined();
    const plainText = required(plain.content[0]).text ?? "";
    expect(plainText).toContain("after rendering");
    expect(plainText.endsWith("\n\nuiDiscarded: true")).toBe(true);
    expect(plainText).not.toContain("a rendered view");

    const structured = await uiHandler(failing)({
      code: "ignored",
      diagnostics: true,
    });
    expect(structured.isError).toBe(true);
    expect(structured._meta).toBeUndefined();
    const envelope = envelopeOf(structured);
    expect(envelope.uiDiscarded).toBe(true);
    expect(envelope.emittedDiscarded).toBeUndefined();
  });

  it("reports both discards when one failure loses blocks and a view", async () => {
    const failing = scriptedExecutor(async (fns) => {
      await required(fns.emit)({ type: "text", text: "doomed" });
      await required(fns.ui)(VIEW);
      throw new Error("after both");
    });
    const plainText =
      required((await uiHandler(failing)({ code: "ignored" })).content[0]).text ??
      "";
    expect(plainText).toContain("\n\nemittedDiscarded: 1\nuiDiscarded: true");

    const envelope = envelopeOf(
      await uiHandler(failing)({ code: "ignored", diagnostics: true }),
    );
    expect(envelope.emittedDiscarded).toBe(1);
    expect(envelope.uiDiscarded).toBe(true);
  });

  it("says nothing about a view a failed program never asked for", async () => {
    const failing = scriptedExecutor(async () => {
      throw new Error("nothing rendered");
    });
    const plainText =
      required((await uiHandler(failing)({ code: "ignored" })).content[0]).text ??
      "";
    expect(plainText).not.toContain("uiDiscarded");
    const envelope = envelopeOf(
      await uiHandler(failing)({ code: "ignored", diagnostics: true }),
    );
    expect(envelope.uiDiscarded).toBeUndefined();
  });

  it("reports a distinct ui byte aggregate in diagnostics, numbers only", async () => {
    const out = await uiHandler(
      scriptedExecutor(async (fns) => {
        await required(fns.emit)({ type: "text", text: "measured" });
        await required(fns.ui)(VIEW);
        return "done";
      }),
    )({ code: "ignored", diagnostics: true });
    const diagnostics = envelopeOf(out).diagnostics as {
      ui?: number;
      emitted?: { count: number; bytes: number };
    };
    expect(diagnostics.ui).toBe(JSON.stringify({ html: VIEW }).length);
    // Distinct from the emitted pair, which still reports only block bytes.
    expect(diagnostics.emitted).toEqual({
      count: 1,
      bytes: JSON.stringify({ type: "text", text: "measured" }).length,
    });

    const quiet = await uiHandler(scriptedExecutor(async () => "done"))({
      code: "ignored",
      diagnostics: true,
    });
    expect(
      (envelopeOf(quiet).diagnostics as { ui?: number }).ui,
    ).toBeUndefined();
  });
});

describe("the Apps shell (U5, U6)", () => {
  it("is a structurally valid HTML5 document at a versioned address", () => {
    expect(PROGRAM_UI_RESOURCE_URI).toBe("ui://connecta/program-ui/v1");
    expect(PROGRAM_UI_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(MCP_APPS_EXTENSION).toBe("io.modelcontextprotocol/ui");
    expect(PROGRAM_UI_SHELL_HTML.startsWith("<!doctype html>")).toBe(true);
    expect(PROGRAM_UI_SHELL_HTML.trimEnd().endsWith("</html>")).toBe(true);

    const { elements, unclosed } = walkTags(PROGRAM_UI_SHELL_HTML);
    // Every element opened is closed, in order, by the end of the document.
    expect(unclosed).toEqual([]);
    const names = elements.map((element) => element.name);
    for (const required_ of ["html", "head", "title", "style", "body", "iframe", "script"]) {
      expect(names, required_).toContain(required_);
    }
    expect(names.indexOf("head")).toBeLessThan(names.indexOf("body"));
    const html = required(elements.find((element) => element.name === "html"));
    expect(html.attrs).toContain('lang="en"');
    const iframe = required(elements.find((element) => element.name === "iframe"));
    expect(iframe.attrs).toContain('sandbox="allow-scripts"');
    expect(iframe.attrs).toContain('id="program-view"');
    expect(iframe.attrs).toContain("srcdoc");
  });

  it("renders the payload in a sandboxed srcdoc frame with no same-origin", () => {
    expect(PROGRAM_UI_SHELL_HTML).toContain('sandbox="allow-scripts"');
    expect(PROGRAM_UI_SHELL_HTML).toContain('srcdoc=""');
    expect(PROGRAM_UI_SHELL_HTML).toContain("view.srcdoc = html");
    expect(PROGRAM_UI_SHELL_HTML).not.toContain("allow-same-origin");
    // No declared CSP domains: the host's restrictive default is the offline
    // guarantee, and the srcdoc frame inherits it.
    expect(PROGRAM_UI_SHELL_HTML).not.toContain("Content-Security-Policy");
  });

  it("opens the handshake with params the Apps initialize schema accepts", () => {
    // The schema requires all three. A host that registers it rejects a
    // request missing any one with a JSON-RPC error, and the shell then never
    // receives the tool result it exists to render — so pin the exact key set
    // and let a future schema drift fail here rather than in a host.
    const params = shellInitializeParams();
    expect(Object.keys(params).sort()).toEqual([
      "appCapabilities",
      "appInfo",
      "protocolVersion",
    ]);
    expect(params.appInfo).toEqual({
      name: "connecta program view",
      version: "1",
    });
    expect(params.appCapabilities).toEqual({});
    expect(params.protocolVersion).toBe("2026-01-26");
  });

  it("announces initialized only on a result, and answers teardown", () => {
    // An error response to `ui/initialize` carries the same id. Claiming the
    // handshake completed on one would assert something that did not happen.
    expect(PROGRAM_UI_SHELL_HTML).toContain(
      "message.id === initializeId && message.result !== undefined",
    );
    // `ui/resource-teardown` is a request, not a notification: the host waits
    // on the reply before tearing the view down.
    expect(PROGRAM_UI_SHELL_HTML).toContain(
      'send({ jsonrpc: "2.0", id: message.id, result: {} });',
    );
    // Nothing answers `ui/initialize` — it is App-to-Host only, so a branch
    // replying to one would be answering a message no host sends.
    expect(PROGRAM_UI_SHELL_HTML).not.toContain(
      'message.method === "ui/initialize"',
    );
  });

  it("reports a fixed box, because it has no content-height signal", () => {
    // The shell cannot see inside the payload frame — that is the isolation,
    // not an oversight — so `size-changed` carries the shell's own box and
    // program views are fixed-height by construction.
    expect(PROGRAM_UI_SHELL_HTML).toContain("min-height: 480px;");
    expect(PROGRAM_UI_SHELL_HTML).toContain(
      "document.documentElement.scrollHeight",
    );
    expect(PROGRAM_UI_SHELL_HTML).toContain(
      "Program views are fixed-height by construction",
    );
  });

  it("speaks the Apps lifecycle and forwards no channel from the inner frame", () => {
    for (const method of [
      "ui/initialize",
      "ui/notifications/initialized",
      "ui/notifications/tool-result",
      "ui/notifications/size-changed",
      "ui/resource-teardown",
    ]) {
      expect(PROGRAM_UI_SHELL_HTML).toContain(method);
    }
    expect(PROGRAM_UI_SHELL_HTML).toContain(`meta["${PROGRAM_UI_META_KEY}"]`);
    // Every outbound message goes to the host and nowhere else, and anything
    // arriving from a source that is not the host is dropped before it is
    // read — so the payload frame has no path to the host at all.
    expect(PROGRAM_UI_SHELL_HTML).toContain("event.source !== host");
    expect(PROGRAM_UI_SHELL_HTML.match(/postMessage/g)).toEqual([
      "postMessage",
    ]);
    expect(PROGRAM_UI_SHELL_HTML).toContain("host.postMessage(message,");
    expect(PROGRAM_UI_SHELL_HTML).not.toContain("contentWindow");
  });
});
