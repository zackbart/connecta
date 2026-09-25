// The built-in artifacts connector through a real deployment: the typed slot,
// the tool surface, approval exemption, conflicts, authorship, the guide, and
// the render-check hook.
//
// Programs are closures run by a scripted executor keyed by program text, as
// in the resumable-writes suite; workerd forbids eval and this suite runs in
// both projects.

import { describe, expect, it, vi } from "vitest";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import {
  artifacts,
  kvArtifactStore,
  type ArtifactRenderCheck,
  type ArtifactStore,
} from "../src/artifacts.js";
import { runRenderCheck } from "../src/artifacts/connector.js";
import { bearerToken } from "../src/auth/bearer.js";
import { createConnecta, type ConnectaConfig } from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Executor, ExecutorProvider } from "../src/types.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { required } from "./helpers.js";

const BASE = "https://connecta.test";
const ALICE = "alice-token";
const BOB = "bob-token";

interface Guest {
  call(address: string, args?: unknown): Promise<any>;
}
type Program = (connecta: Guest) => Promise<unknown>;

/** Rebuild a typed guest error the way the trusted prelude does. */
function guestError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = "\u001econnecta-error:";
  if (!message.startsWith(prefix)) return error instanceof Error ? error : new Error(message);
  const rest = message.slice(prefix.length);
  const details = JSON.parse(rest.slice(rest.indexOf(":") + 1)) as { code: string; message: string };
  return Object.assign(new Error(details.message), { code: details.code, details });
}

function scriptedExecutor(programs: Map<string, Program>): Executor {
  return {
    async execute(code: string, providers: ExecutorProvider[]) {
      const program = programs.get(code.trim());
      if (!program) return { result: undefined, error: `no program for ${code}` };
      const provider = required(providers[0]);
      const connecta = new Proxy({} as Guest, {
        get: (_target, name: string) => async (...args: unknown[]) => {
          try {
            return await required(provider.fns[name])(...args);
          } catch (error) {
            throw guestError(error);
          }
        },
      });
      try {
        return { result: await program(connecta) };
      } catch (error) {
        return { result: undefined, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

const page = (body: string) => `<!doctype html>\n<main id="artifact-root">${body}</main>\n`;

interface Setup {
  store?: ArtifactStore;
  renderCheck?: ArtifactRenderCheck;
  config?: Partial<ConnectaConfig>;
}

function deploy(setup: Setup = {}) {
  const programs = new Map<string, Program>();
  const events: ToolCallActivityEvent[] = [];
  const store = setup.store ?? kvArtifactStore(memoryStorage());
  const app = createConnecta({
    connectors: [],
    executor: scriptedExecutor(programs),
    logger: "silent",
    publicUrl: BASE,
    storage: memoryStorage(),
    auth: [
      bearerToken(ALICE, { subjectId: "alice" }),
      bearerToken(BOB, { subjectId: "bob" }),
    ],
    activity: activityHistory({ store: { record: (event) => void events.push(event) } }),
    artifacts: artifacts({
      store,
      ...(setup.renderCheck ? { renderCheck: setup.renderCheck } : {}),
    }),
    ...setup.config,
  });
  let counter = 0;
  const call = async (name: string, args: Record<string, unknown>, token = ALICE) => {
    const body = await readJsonRpc(
      await mcpRpc(app, "tools/call", { name, arguments: args }, { baseUrl: BASE, token }),
    );
    if (body.error) throw new Error(JSON.stringify(body.error));
    return body.result as { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: any };
  };
  const json = (result: { content: { text: string }[] }) => JSON.parse(required(result.content[0]).text);
  const errorOf = (result: { isError?: boolean; structuredContent?: any }) => {
    expect(result.isError).toBe(true);
    return result.structuredContent.error;
  };
  const run = async (program: Program, token = ALICE) => {
    const code = `async () => ${++counter}`;
    programs.set(code, program);
    return call("execute_code", { code }, token);
  };
  const destructive = (address: string, args: Record<string, unknown>, token = ALICE) =>
    call("call_destructive_tool", { address, args }, token);
  return { app, store, events, call, json, errorOf, run, destructive };
}

const CREATE = {
  id: "q3-bugs",
  title: "Q3 bugs",
  kind: "html",
  source: page("<h1>Bugs by team</h1><script>document.title = window.artifact.data.data.title</script>"),
  documents: { data: { title: "Q3" } },
};

describe("the artifacts slot", () => {
  it("adds exactly the artifacts tools with read and write annotations", async () => {
    const { app } = deploy();
    const connector = required(app.registry.getConnector("artifacts"));
    expect(connector.approval).toBe("never");
    expect(connector.kind).toBe("api");
    const tools = required(connector.staticTools);
    expect(tools.map((tool) => [tool.name, tool.annotations])).toEqual([
      ["list_artifacts", { readOnlyHint: true }],
      ["get_artifact", { readOnlyHint: true }],
      ["get_document", { readOnlyHint: true }],
      ["validate_artifact", { readOnlyHint: true }],
      ...[
        "create_artifact",
        "update_artifact",
        "patch_artifact",
        "set_documents",
        "rollback_artifact",
        "archive_artifact",
        "restore_artifact",
      ].map((name) => [
        name,
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      ]),
    ]);
  });

  it("refuses a hand-made module, a clashing connector id, and a missing publicUrl", () => {
    const base = { connectors: [], executor: scriptedExecutor(new Map()), logger: "silent" as const };
    expect(() =>
      createConnecta({ ...base, publicUrl: BASE, artifacts: { connector: { id: "x" } } as never }),
    ).toThrow(/must be created with artifacts\(\.\.\.\)/);
    const module = artifacts({ store: kvArtifactStore(memoryStorage()) });
    expect(() =>
      createConnecta({
        ...base,
        publicUrl: BASE,
        connectors: [{ id: "artifacts", listTools: async () => [], callTool: async () => null }],
        artifacts: module,
      }),
    ).toThrow(/"artifacts" is reserved by the artifacts module/);
    expect(() => createConnecta({ ...base, artifacts: module })).toThrow(/needs publicUrl/);
    expect(() => artifacts({ store: {} as ArtifactStore })).toThrow(/must be an ArtifactStore/);
    expect(() => artifacts({ store: kvArtifactStore(memoryStorage()), extra: 1 } as never)).toThrow(
      /unknown option "extra"/,
    );
    expect(() =>
      artifacts({ store: kvArtifactStore(memoryStorage()), allowlist: { scripts: ["http://x.test"] } }),
    ).toThrow(/exact https: origins/);
  });

  it("serves the guide as connector:artifacts, required before writes and not reads", async () => {
    const { call, json } = deploy();
    const listed = await call("skills", {});
    expect(listed.content.map((block) => block.text).join("\n")).toContain("connector:artifacts");
    const guide = await call("skills", { name: "connector:artifacts" });
    const text = guide.content.map((block) => block.text).join("\n");
    expect(text).toContain('id="artifact-root"');
    expect(text).toContain("https://cdn.jsdelivr.net");
    expect(text).toContain("| Page source | 1 MiB |");
    const found = json(
      await call("search_tools", { query: "artifact", connector: "artifacts", limit: 20 }),
    );
    const rows = found.connectors[0].tools as { name: string; guideRequiredReasons?: string[] }[];
    const reasons = Object.fromEntries(rows.map((row) => [row.name, row.guideRequiredReasons]));
    expect(reasons.get_artifact).toBeUndefined();
    expect(reasons.list_artifacts).toBeUndefined();
    expect(reasons.create_artifact).toEqual(["approval_required"]);
    expect(reasons.patch_artifact).toEqual(["approval_required"]);
  });
});

describe("writing through the connector", () => {
  it("runs writes unasked inside execute_code, spending the write budget and recording activity", async () => {
    const { run, json, events } = deploy({ config: { execute: { maxWrites: 2 } } });
    const created = json(
      await run(async (connecta) => {
        const made = await connecta.call("artifacts.create_artifact", CREATE);
        const read = await connecta.call("artifacts.get_artifact", { id: "q3-bugs", includeSource: false });
        const patched = await connecta.call("artifacts.patch_artifact", {
          id: "q3-bugs",
          baseVersion: read.view.version,
          edits: [{ find: "Bugs by team", replace: "Open bugs by project" }],
        });
        try {
          await connecta.call("artifacts.set_documents", {
            id: "q3-bugs",
            documents: { data: { baseVersion: 1, value: {} } },
          });
        } catch (error) {
          return { made, patched, third: (error as { code: string }).code };
        }
        return { made, patched };
      }),
    );
    expect(created.result).toMatchObject({
      made: { id: "q3-bugs", revision: 1, url: `${BASE}/artifacts/q3-bugs`, view: { version: 1 }, documents: { data: 1 } },
      patched: { revision: 2, view: { version: 2 } },
      third: "budget_exceeded",
    });
    const writes = events.filter((event) => event.connectorId === "artifacts");
    expect(writes.map((event) => [event.toolName, event.outcome, event.errorCode])).toEqual([
      ["create_artifact", "success", undefined],
      ["get_artifact", "success", undefined],
      ["patch_artifact", "success", undefined],
      ["set_documents", "error", "budget_exceeded"],
    ]);
    expect(new Set(writes.map((event) => event.source))).toEqual(new Set(["execute_code"]));
    for (const event of writes) {
      expect(Object.keys(event)).not.toContain("args");
      expect(JSON.stringify(event)).not.toContain("Bugs by team");
    }
  });

  it("pauses writes when the deployment asks for approval", async () => {
    const { run, json } = deploy({ config: { execute: { approval: { artifacts: "ask" } } } });
    const paused = json(await run(async (connecta) => connecta.call("artifacts.create_artifact", CREATE)));
    expect(paused.paused).toMatchObject({ address: "artifacts.create_artifact" });
    const perTool = deploy({ config: { execute: { approval: { "artifacts.create_artifact": "ask" } } } });
    const alsoPaused = perTool.json(
      await perTool.run(async (connecta) => connecta.call("artifacts.create_artifact", CREATE)),
    );
    expect(alsoPaused.paused).toBeDefined();
  });

  it("refuses writes on call_tool and runs them on call_destructive_tool", async () => {
    const { call, destructive, json } = deploy();
    const refused = await call("call_tool", { address: "artifacts.create_artifact", args: CREATE });
    expect(refused.isError).toBe(true);
    expect(json(refused).error.code).toBe("destructive_tool_requires_approval");
    const done = await destructive("artifacts.create_artifact", CREATE);
    expect(done.isError).toBeFalsy();
    expect(json(done)).toMatchObject({ id: "q3-bugs", url: `${BASE}/artifacts/q3-bugs` });
    const read = json(await call("call_tool", { address: "artifacts.get_artifact", args: { id: "q3-bugs" } }));
    expect(read.view.source).toBe(CREATE.source);
    expect(read.snapshotUrl).toBe(`${BASE}/artifacts/q3-bugs/v/1?d=data:1`);
  });

  it("answers a stale base with a typed conflict carrying where things stand", async () => {
    const { destructive, run, json, errorOf } = deploy();
    await destructive("artifacts.create_artifact", CREATE);
    await destructive("artifacts.update_artifact", { id: "q3-bugs", baseVersion: 1, source: page("<p>2</p>") });
    const stale = await destructive("artifacts.update_artifact", {
      id: "q3-bugs",
      baseVersion: 1,
      source: page("<p>late</p>"),
    });
    expect(stale.isError).toBe(true);
    expect(errorOf(stale)).toMatchObject({
      code: "conflict",
      retryable: false,
      current: { revision: 2, view: 2, "document:data": 1 },
      message:
        "Artifact 'q3-bugs' view is at version 2, not 1. Re-read it with artifacts.get_artifact, " +
        "reapply the change, and retry with baseVersion 2.",
    });
    const caught = json(
      await run(async (connecta) => {
        try {
          await connecta.call("artifacts.update_artifact", { id: "q3-bugs", baseVersion: 1, source: page("x") });
        } catch (error) {
          const typed = error as { code: string; details: { retryable: boolean; current: unknown } };
          return { code: typed.code, retryable: typed.details.retryable, current: typed.details.current };
        }
        return "no conflict";
      }),
    );
    expect(caught.result, JSON.stringify(caught)).toEqual({
      code: "conflict",
      retryable: false,
      current: { revision: 2, view: 2, "document:data": 1 },
    });
  });

  it("records the authenticated caller on every version, never an argument", async () => {
    const { destructive, call, json } = deploy();
    await destructive("artifacts.create_artifact", { ...CREATE, by: { kind: "forged" } }).catch(() => {});
    await destructive("artifacts.create_artifact", CREATE, ALICE);
    await destructive("artifacts.patch_artifact", {
      id: "q3-bugs",
      baseVersion: 1,
      edits: [{ find: "Bugs by team", replace: "Bugs" }],
    }, BOB);
    const read = json(await call("call_tool", { address: "artifacts.get_artifact", args: { id: "q3-bugs" } }));
    expect(read.history.map((entry: { by: unknown; op: string }) => [entry.op, entry.by])).toEqual([
      ["patch", { kind: "bearer", id: "bob" }],
      ["create", { kind: "bearer", id: "alice" }],
    ]);
    const listed = json(await call("call_tool", { address: "artifacts.list_artifacts", args: {} }));
    expect(listed.artifacts[0]).toMatchObject({ id: "q3-bugs", updatedBy: { kind: "bearer", id: "bob" }, viewVersion: 2 });
  });

  it("lists every validation error, with its line, in the refusal", async () => {
    const { destructive, errorOf } = deploy();
    const refused = await destructive("artifacts.create_artifact", {
      ...CREATE,
      source: "<!doctype html>\n<iframe></iframe>\n<img src=\"a.png\">",
    });
    expect(refused.isError).toBe(true);
    const error = errorOf(refused);
    expect(error.code).toBe("invalid_args");
    expect(error.message).toBe(
      "The artifact failed validation with 3 errors; nothing was saved.\n" +
        '- No element has id="artifact-root". Wrap the page in <main id="artifact-root">…</main>.\n' +
        "- Line 2: <iframe> is not allowed; pages cannot embed other pages. Remove it.\n" +
        '- Line 3: <img src="a.png"> is relative; pages have no files beside them. Embed it as a data: URL.',
    );
  });
});

describe("the render-check hook", () => {
  it("hands the hook the exact frame document and CSP, and keeps its warnings", async () => {
    const renderCheck = vi.fn<ArtifactRenderCheck>(async () => ({ ok: true, warnings: ["slow chart"] }));
    const { destructive, call, json } = deploy({ renderCheck });
    const made = json(await destructive("artifacts.create_artifact", CREATE));
    expect(made.warnings).toEqual(["Render check: slow chart"]);
    const input = required(renderCheck.mock.calls[0])[0];
    expect(input.kind).toBe("html");
    expect(input.csp).toMatch(/^sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net/);
    expect(input.csp).toContain("connect-src 'none'");
    expect(input.document.startsWith('<!doctype html><script>(()=>{')).toBe(true);
    expect(input.document).toContain('"data":{"data":{"title":"Q3"}}');
    expect(input.signal).toBeInstanceOf(AbortSignal);
    const checked = json(
      await call("call_tool", { address: "artifacts.validate_artifact", args: { kind: "markdown", source: "# x" } }),
    );
    expect(checked).toMatchObject({ ok: true, renderCheck: { ok: true } });
  });

  it("refuses a write the hook fails, and fails a write retryably when the hook throws", async () => {
    let mode: "fail" | "throw" = "fail";
    const renderCheck: ArtifactRenderCheck = async () => {
      if (mode === "throw") throw new Error("browser crashed with secret-token-xyz");
      return { ok: false, errors: ["TypeError: x is undefined", "y".repeat(400)] };
    };
    const { destructive, errorOf, store, call } = deploy({ renderCheck });
    const failed = errorOf(await destructive("artifacts.create_artifact", CREATE));
    expect(failed.code).toBe("invalid_args");
    expect(failed.message).toContain("- Render check: TypeError: x is undefined");
    expect(failed.message).toContain(`- Render check: ${"y".repeat(299)}…`);
    expect(await store.head("q3-bugs")).toBeNull();
    mode = "throw";
    // Plain-text failures carry only the message on the default result mode.
    const thrown = await call("call_destructive_tool", {
      address: "artifacts.create_artifact",
      args: CREATE,
      resultMode: "value",
    });
    expect(thrown.structuredContent.error).toMatchObject({ code: "unavailable", retryable: true });
    expect(JSON.stringify(thrown)).not.toContain("secret-token-xyz");
    expect(await store.head("q3-bugs")).toBeNull();
  });

  it("gives up on a hook that never answers after 20 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let signal: AbortSignal | undefined;
      const pending = runRenderCheck(
        async (input) => {
          signal = input.signal;
          return new Promise(() => {});
        },
        { document: "<!doctype html>", csp: "sandbox", kind: "html" },
        undefined,
      );
      await vi.advanceTimersByTimeAsync(19_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await pending).toMatchObject({ ok: false, unavailable: expect.stringMatching(/did not answer in time/) });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
