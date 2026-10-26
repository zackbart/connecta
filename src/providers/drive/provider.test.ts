// Google Drive fixture regressions cover bounded/ranged reads, cursors,
// size guards, uploads and refusals. Delegation, subjects and tokens are covered
// by test/google-workspace-delegation.test.ts, including both transports.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { drive } from "./index.js";
import { driveIndex, DRIVE_HATCH, DRIVE_REFUSALS } from "./lib/hatch.js";
import { DRIVE_VALUE_SAFETY } from "./safety.js";
import { reviewProblems } from "../../../test/fixtures/value-safety.js";
import candidates from "./evidence/value-safety.json";
import source from "./evidence/openapi.json";
import { accessTokens } from "../../access-tokens.js";
import { issueAgentToken } from "../../../test/helpers/agent-tokens.js";
import { readJsonRpc } from "../../../test/fixtures/http.js";
import { memoryStorage } from "../../storage/memory.js";
import { createTestConnecta, makeRegistry, silentLogger } from "../../../test/helpers.js";
import type { AuthenticatedIdentity, Connector, ConnectorContext } from "../../types.js";

// The final-size guard is the last word on every result, and every source is
// budgeted before it, so nothing ordinary reaches it. The sizing module passes
// through untouched unless a test says which result to report as oversized.
const sizing = vi.hoisted(() => ({ oversized: undefined as ((value: unknown) => boolean) | undefined }));
vi.mock("../_shared/google/result-size.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/google/result-size.js")>();
  return {
    ...actual,
    jsonBytes: (value: unknown) => (sizing.oversized?.(value) ? 1_000_000_000 : actual.jsonBytes(value)),
  };
});

const ACCESS_TOKEN = "q7J4x9N2v6C8r3L5";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const keys = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;

interface ApiCall {
  url: URL;
  method: string;
  headers: Headers;
  /** A JSON body, parsed. */
  body: any;
  /** A raw body, as bytes. */
  raw: Uint8Array | undefined;
}

interface Reply {
  status?: number;
  /** JSON body. */
  body?: unknown;
  /** Text or bytes body, sent as is with `contentType`. */
  payload?: string | Uint8Array;
  contentType?: string;
  /** A streamed body, for reads that must stop early or replies that break. */
  stream?: ReadableStream<Uint8Array>;
  /** Response headers beyond the content type. */
  headers?: Record<string, string>;
  /** Send nothing back at all: the connection fails after the request left. */
  network?: true;
}

type Route = (call: ApiCall) => Reply | undefined;

const calls: ApiCall[] = [];
let tokenCalls = 0;
let sharedStorage = memoryStorage();
let route: Route = () => undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  sharedStorage = memoryStorage();
  sizing.oversized = undefined;
  calls.length = 0;
  tokenCalls = 0;
  route = () => undefined;
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      tokenCalls += 1;
      return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3599 });
    }
    const call: ApiCall = {
      url: new URL(url),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      raw: init.body instanceof Uint8Array ? init.body : undefined,
    };
    calls.push(call);
    const reply = route(call) ?? {};
    if (reply.network) throw new TypeError("fetch failed: connection reset");
    const headers = { "Content-Type": reply.contentType ?? "application/octet-stream", ...reply.headers };
    if (reply.stream) return new Response(reply.stream, { status: reply.status ?? 200, headers });
    if (reply.payload !== undefined) {
      return new Response(reply.payload, { status: reply.status ?? 200, headers });
    }
    if (reply.status === 204) return new Response(null, { status: 204 });
    return Response.json(reply.body ?? {}, {
      status: reply.status ?? 200,
      ...(reply.headers ? { headers: reply.headers } : {}),
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

let accounts = 0;
function connection(overrides: Record<string, unknown> = {}): Connector {
  accounts += 1;
  return drive("files", {
    purpose: "Church staff documents",
    serviceAccount: { clientEmail: `drive-${accounts}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
    subject: "pastor@church.example",
    ...overrides,
  } as Parameters<typeof drive>[1]);
}

function context(): ConnectorContext {
  return { storage: sharedStorage, logger: silentLogger, baseUrl: "https://connecta.example" };
}

function call(connector: Connector, name: string, args: Record<string, unknown> = {}, ctx = context()): Promise<any> {
  return connector.callTool(name, args, ctx) as Promise<any>;
}

const GOOGLE_ERROR = (code: number, reason: string, message: string) => ({
  status: code,
  body: { error: { code, message, errors: [{ reason, message }] } },
});

const serialized = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("reading content", () => {
  function metadata(file: Record<string, unknown>): Route {
    return (request) =>
      request.url.searchParams.get("fields") ? { body: { id: "f1", name: "F", ...file } } : undefined;
  }

  it("INV-1 INV-5 INV-9: preserves Drive error facts, guarded decisions and reviewed metadata dispatch", async () => {
    installOwnedTransport();
    const meta = metadata({ mimeType: "application/vnd.google-apps.document", capabilities: { canDownload: true } });
    const message = "Request refused.";
    route = (request) => meta(request) ?? GOOGLE_ERROR(403, "exportSizeLimitExceeded", message);
    const failure = await call(connection(), "get_file_content", { fileId: "f1" }).catch((error) => error);
    expect(failure).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      message:
        "Google Drive: Request refused. The item is larger than Google will export in this format. Download the original file instead, or export a smaller part.",
    });

    // Identical status and prose with a different reason gets its own verdict.
    calls.length = 0;
    route = (request) => meta(request) ?? GOOGLE_ERROR(403, "domainPolicy", message);
    const policy = await call(connection(), "get_file_content", { fileId: "f1" }).catch((error) => error);
    expect(policy).toMatchObject({ code: "provider_permission_denied", retryable: false });
    expect(policy.message).toContain("domain policy");
    expect(policy.message).not.toContain("export");

    for (const problems of Object.values(
      reviewProblems({ table: DRIVE_VALUE_SAFETY, index: driveIndex, source, candidates }),
    ))
      expect(problems).toEqual([]);
    expect(driveIndex.ops).toHaveLength(64);
    expect(Object.values(DRIVE_HATCH.verdicts).filter((v) => v !== "refuse")).toHaveLength(13);
    for (const op of driveIndex.ops) {
      if (DRIVE_REFUSALS[`${op.method} ${op.path}`]) expect(op.summary).toMatch(/^Refused: .+; .+\.$/);
      expect(op.summary!.length).toBeLessThanOrEqual(120);
    }
    const connector = connection();
    for (const [query, operation] of [
      ["find files by name", "drive.files.list"],
      ["list folder contents", "drive.files.list"],
      ["shared drives", "drive.drives.list"],
      ["list file revisions", "drive.revisions.list"],
      ["upload attachment", "drive.files.create"],
      ["save file", "drive.files.create"],
      ["rename file", "drive.files.update"],
      ["move file to folder", "drive.files.update"],
      ["change permission role", "drive.permissions.update"],
      ["share file without emailing", "drive.permissions.create"],
      ["permanently delete a file", "drive.files.delete"],
      ["generate CSE token", "drive.files.generateCseToken"],
      ["watch files", "drive.files.watch"],
    ] as const) {
      const found = await call(connector, "drive_api_search", { query, limit: 2 });
      expect(
        found.operations.map((op: any) => op.operationId),
        query,
      ).toContain(operation);
    }
    for (const [name, args, path] of [
      ["search_files", {}, "items[].name"],
      ["list_folder_items", { folderId: "root" }, "items[].name"],
      ["list_shared_drives", {}, "items[].name"],
      ["list_permissions", { fileId: "f1" }, "items[].displayName"],
      ["get_file", { fileId: "f1" }, "name"],
      ["get_file_content", { fileId: "f1", maxChars: 2 }, "content"],
    ] as const) {
      route = (request) =>
        request.url.searchParams.get("alt") === "media"
          ? { payload: "abcdef", contentType: "text/plain" }
          : {
              body: {
                id: "f1",
                name: "N".repeat(40_000),
                mimeType: "text/plain",
                files: [{ id: "f1", name: "N".repeat(40_000) }],
                drives: [{ id: "d1", name: "N".repeat(40_000) }],
                permissions: [{ id: "p1", displayName: "N".repeat(40_000) }],
              },
            };
      const selected = await call(connector, name, { ...args, fields: ["id"] });
      expect(selected.truncated, name).toContain(path);
      if (selected.items) {
        expect(selected.items[0].truncated, name).toContain(path.replace("items[].", ""));
        expect(Object.keys(selected.items[0]).sort()).toEqual(["id", "truncated"]);
      } else expect(Object.keys(selected).sort()).toEqual(["id", "truncated"]);
    }
    for (const args of [
      { method: "DELETE", path: "/files/f1" },
      { method: "POST", path: "/files", body: { parents: ["old-[redacted]"] } },
      { method: "POST", path: "/files", body: { mimeType: "text/[redacted]" } },
      { method: "DELETE", path: "/files/trash" },
      { method: "POST", path: "/files/f1/watch", body: {} },
      { method: "POST", path: "/files/f1/download", body: {} },
      { method: "POST", path: "/files/f1/permissions", body: { type: "anyone", role: "reader" } },
      { method: "PATCH", path: "/files/f1/permissions/p1", body: { role: "owner" } },
      {
        method: "PATCH",
        path: "/files/f1/permissions/p1",
        query: { transferOwnership: true },
        body: { role: "writer" },
      },
      { method: "POST", path: "/files", query: { uploadType: "media" }, body: { name: "x" } },
    ]) {
      calls.length = 0;
      const before = tokenCalls;
      const error = await call(connector, "drive_api_write", args).catch((e) => e);
      expect(error).toMatchObject({ code: "invalid_args" });
      if (args.path === "/files/f1/permissions") expect(error.message).toContain("share_file");
      expect(calls).toEqual([]);
      expect(tokenCalls).toBe(before);
    }
    for (const [tool, args] of [
      ["get_file", { fileId: "generateCseToken" }],
      ["drive_api_read", { path: "/files/generateCseToken" }],
      ["drive_api_read", { path: "/files/%67enerateCseToken" }],
      ["drive_api_read", { path: "/files/f1", query: { alt: "media" } }],
      ["get_file", { fileId: "f1", fields: ["madeUp"] }],
      ["search_files", { fields: ["madeUp"] }],
    ] as const) {
      calls.length = 0;
      await expect(call(connector, tool, args)).rejects.toMatchObject({ code: "invalid_args" });
      expect(calls).toEqual([]);
    }
    for (const reply of [
      GOOGLE_ERROR(500, "backendError", "Lookup failed"),
      { network: true },
      {
        stream: new ReadableStream({
          start(c) {
            c.error(new Error("broken"));
          },
        }),
      },
    ] as Reply[]) {
      calls.length = 0;
      route = () => reply;
      const error = await call(connector, "move_file", { fileId: "f1", folderId: "root" }).catch((e) => e);
      expect(error.message).not.toMatch(/outcome is unknown|may have been applied/);
      expect(error.writeOutcome).toBeUndefined();
      expect(
        calls.map((c) => c.method),
        JSON.stringify(error),
      ).toEqual(["GET"]);
    }
    calls.length = 0;
    route = () => ({ body: { "pa[redacted]rents": ["old-1"] } });
    await expect(call(connector, "move_file", { fileId: "f1", folderId: "root" })).rejects.toMatchObject({
      code: "connector_call_failed",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    for (const parents of [[], ["old-1"], ["root"], undefined]) {
      calls.length = 0;
      route = (r) =>
        r.method === "GET"
          ? { body: parents === undefined ? {} : { parents } }
          : GOOGLE_ERROR(500, "backendError", "Move failed");
      const error = await call(connector, "move_file", { fileId: "f1", folderId: "root" }).catch((e) => e);
      expect(error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
      expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
      expect(calls[1]!.url.searchParams.get("removeParents")).toBe(parents?.includes("old-1") ? "old-1" : null);
    }
    for (const parents of [["[redacted]"], [`old-${ACCESS_TOKEN}-parent`], "[redacted]", null]) {
      calls.length = 0;
      route = () => ({ body: { parents } });
      const error = await call(connector, "move_file", { fileId: "f1", folderId: "root" }).catch((e) => e);
      expect(error).toMatchObject({ code: "connector_call_failed" });
      expect(error.writeOutcome).toBeUndefined();
      expect(
        calls.map((c) => c.method),
        JSON.stringify(error),
      ).toEqual(["GET"]);
    }
    for (const metadata of [
      { mimeType: `text/${ACCESS_TOKEN}` },
      { mimeType: "[redacted]" },
      { "mi[redacted]meType": "text/plain" },
      { mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: ACCESS_TOKEN } },
      {
        mimeType: "application/vnd.google-apps.shortcut",
        shortcutDetails: { targetId: "ok", targetMimeType: `text/${ACCESS_TOKEN}` },
      },
      { mimeType: "text/plain", capabilities: { canDownload: "[redacted]" } },
    ]) {
      calls.length = 0;
      route = () => ({ body: metadata });
      await expect(call(connector, "get_file_content", { fileId: "f1" })).rejects.toMatchObject({
        code: "connector_call_failed",
      });
      expect(calls).toHaveLength(1);
    }
    calls.length = 0;
    route = () => ({ body: { mimeType: "application/vnd.google-apps.folder", driveId: ACCESS_TOKEN } });
    await expect(call(connector, "list_folder_items", { folderId: "folder1" })).rejects.toMatchObject({
      code: "connector_call_failed",
    });
    expect(calls).toHaveLength(1);
    route = () => ({
      body: {
        id: "f1",
        resourceKey: "private",
        webViewLink: "https://drive.google.com/file/d/f1/view?resourcekey=private",
        clientEncryptionDetails: { decryptionMetadata: { jwt: "private" } },
        description: "See https://drive.google.com/open?id=f1&%72esourcekey=private",
        thumbnailLink: "https://example.com/private",
        appProperties: { label: "ok" },
      },
    });
    const safe = await call(connector, "drive_api_read", { path: "/files/f1" });
    expect(JSON.stringify(safe)).not.toContain("private");
    expect(safe.data.appProperties.label).toBe("ok");
    route = () => ({ body: { drives: [{ id: "sd1", backgroundImageLink: "https://example.com/private-image" }] } });
    const sharedDrives = await call(connector, "drive_api_read", { path: "/drives" });
    expect(sharedDrives.data.drives).toEqual([{ id: "sd1", backgroundImageLink: "[redacted]" }]);
    route = () => ({ body: { revisions: [], nextPageToken: "more" } });
    const first = await call(connector, "drive_api_read", {
      path: "/files/f1/revisions",
      query: { fields: "revisions(id)" },
      fields: ["revisions.id"],
    });
    expect(first.page.hasMore).toBe(true);
    expect(calls.at(-1)!.url.searchParams.get("fields")).toBe("revisions(id),nextPageToken");
    route = () => ({ body: { revisions: [{ id: "v1", modifiedTime: "2026-01-01T00:00:00Z" }] } });
    const last = await call(connector, "drive_api_read", {
      path: "/files/f1/revisions",
      query: { fields: "revisions(id)" },
      fields: ["revisions.id"],
      cursor: first.page.nextCursor,
    });
    expect(last.page).toMatchObject({ hasMore: false });
    expect(last.data.revisions).toEqual([{ id: "v1" }]);
    expect(calls.at(-1)!.url.pathname).toBe("/drive/v3/files/f1/revisions");
    expect(calls.at(-1)!.url.searchParams.get("pageToken")).toBe("more");
    const storage = memoryStorage();
    const app = createTestConnecta({
      connectors: [connector],
      agents: ["assistant"],
      pools: {
        native: { tools: ["files"], members: ["agent:assistant"], surface: "native" },
        reads: { tools: ["files"], members: ["agent:assistant"], surface: "native", readOnly: true },
      },
      publicUrl: "https://connecta.example",
      logger: silentLogger,
      storage,
      accessTokens: accessTokens(storage),
    });
    const token = await issueAgentToken(storage, "assistant");
    const rpc = async (pool: string, method: string, params: Record<string, unknown>) =>
      readJsonRpc(
        await app.fetch(
          new Request(`https://connecta.example/agent/${pool}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: `Bearer ${token}`,
              "MCP-Protocol-Version": "2026-07-28",
              "Mcp-Method": method,
              ...(typeof params["name"] === "string" ? { "Mcp-Name": params["name"] } : {}),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              params: {
                ...params,
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              },
            }),
          }),
        ),
      );
    try {
      const catalog = await rpc("reads", "tools/list", {});
      expect(catalog.result.tools.some((t: any) => t.name === "files__drive_api_read")).toBe(true);
      expect(catalog.result.tools.some((t: any) => t.name === "files__drive_api_write")).toBe(false);
      route = () => ({ body: { id: "f1", name: "Review.pdf" } });
      calls.length = 0;
      const read = await rpc("native", "tools/call", {
        name: "files__drive_api_read",
        arguments: { path: "/files/f1", fields: ["id"] },
      });
      expect(read.result.isError).toBeFalsy();
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
      calls.length = 0;
      const written = await rpc("native", "tools/call", {
        name: "files__drive_api_write",
        arguments: { method: "PATCH", path: "/files/f1", body: { name: "Review.pdf" } },
      });
      expect(written.result.isError).toBeFalsy();
      expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
      calls.length = 0;
      await rpc("reads", "tools/call", {
        name: "files__drive_api_write",
        arguments: { method: "PATCH", path: "/files/f1", body: { name: "Denied.pdf" } },
      });
      expect(calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  /** The body a range-honoring server sends for this request's Range header. */
  function ranged(request: ApiCall, body: Uint8Array): Uint8Array {
    const range = /^bytes=0-(\d+)$/.exec(request.headers.get("range") ?? "");
    return range ? body.subarray(0, Number(range[1]) + 1) : body;
  }

  /** Drive's answer to a range from byte 0 of a file with no bytes. */

  /**
   * A body of `total` bytes of `fill`, produced only as it is read, that
   * records how much was pulled and whether the reader gave up on the rest.
   */
  function lazyBody(total: number, fill: number) {
    const CHUNK = 64 * 1024;
    const seen = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (seen.pulled >= total) return controller.close();
          const size = Math.min(CHUNK, total - seen.pulled);
          seen.pulled += size;
          controller.enqueue(new Uint8Array(size).fill(fill));
        },
        cancel() {
          seen.cancelled = true;
        },
        // No read-ahead: every chunk pulled is one the reader asked for.
      },
      { highWaterMark: 0 },
    );
    return { stream, seen, CHUNK };
  }

  it("reads a 17 MiB text body that ignored its range only to the cap, then cancels it", async () => {
    // Past the client's 16 MiB ceiling: without a bound it would fail whole.
    const total = 17 * 1024 * 1024;
    const { stream, seen, CHUNK } = lazyBody(total, 0x61);
    const meta = metadata({ mimeType: "text/plain", size: "5" });
    route = (request) =>
      meta(request) ?? { stream, contentType: "text/plain", headers: { "Content-Length": String(total) } };
    const result = await call(connection(), "get_file_content", { fileId: "f1", maxChars: 10 });
    expect(result.truncated).toContain("content");
    expect(result.content.startsWith("aaaaaaaaaa\n[… truncated: 10 characters")).toBe(true);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThanOrEqual(45 + CHUNK);
  });

  it.each([
    ["honors", true],
    ["ignores", false],
  ])("holds a binary to the cap when metadata understated it and the server %s the range", async (_how, honors) => {
    // Metadata said one byte; the download is 2 MiB.
    const body = new Uint8Array(2 * 1024 * 1024).fill(7);
    const meta = metadata({ mimeType: "application/pdf", size: "1" });
    route = (request) =>
      meta(request) ?? {
        status: honors ? 206 : 200,
        payload: honors ? ranged(request, body) : body,
        contentType: "application/pdf",
      };
    for (const [args, said] of [
      [{}, "does not fit"],
      [{ maxBytes: 4 * 1024 * 1024 }, "more than 1048576 bytes"],
    ] as const) {
      const result = await call(connection(), "get_file_content", { fileId: "f1", ...args });
      expect(result).toMatchObject({ format: "unavailable" });
      expect(result.content).toBeUndefined();
      expect(result.note).toContain(said);
    }
  });

  it("fails a 416 that does not say the file is empty", async () => {
    const meta = metadata({ mimeType: "text/plain", size: "5" });
    route = (request) =>
      meta(request) ?? {
        ...GOOGLE_ERROR(416, "requestedRangeNotSatisfiable", "Request range not satisfiable"),
        headers: { "Content-Range": "bytes */9" },
      };
    await expect(call(connection(), "get_file_content", { fileId: "f1" })).rejects.toMatchObject({
      code: "connector_call_failed",
    });
  });
});

// Worst-case pages pushed through whole calls: CPU-bound, with no timing
// behavior, and on a loaded host close to vitest's 5s default. This is a hang
// guard, not a speed assertion.
describe("every default result crosses into execute_code", { timeout: 60_000 }, () => {
  // A host result reaches a QuickJS program only under 256 KiB serialized
  // (MAX_QUICKJS_HOST_RPC_BYTES). Defaults must fit with room to spare on the
  // worst input Drive can send; explicit maxima may exceed it and are
  // documented as direct-call only, where connecta.result pages them.
  const BUDGET = 196_608;
  // Four UTF-8 bytes each, and a control character JSON escapes to six.
  const worst = (chars: number) => "\u{1F600}\u0001".repeat(Math.ceil(chars / 2)).slice(0, chars * 2);
  const longEmail = `${"a".repeat(64)}@${"b".repeat(250)}.example`;
  const worstFile = (index: number) => ({
    id: `f${index}`.padEnd(44, "x"),
    name: worst(32_767),
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    parents: ["p".repeat(44)],
    driveId: "d".repeat(44),
    size: "9007199254740991",
    modifiedTime: "2026-09-30T12:00:00.000Z",
    webViewLink: `https://drive.google.com/file/d/${"x".repeat(44)}/view?usp=drivesdk`,
    trashed: false,
    owners: [{ emailAddress: longEmail }],
    shortcutDetails: { targetId: "t".repeat(44), targetMimeType: "application/vnd.google-apps.spreadsheet" },
  });

  it("stops a page that would outgrow maxBytes, and resumes at the first row left out", async () => {
    // A hundred rows of 1,000-character escaped names: about 600 KB in all.
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ...worstFile(index),
      id: `r${index}`,
      name: worst(1_000),
    }));
    route = (request) =>
      request.url.searchParams.get("pageToken") === "second"
        ? { body: { files: [{ id: "last" }] } }
        : { body: { files: rows, nextPageToken: "second" } };
    for (const maxBytes of [undefined, 65_536, 100_000]) {
      calls.length = 0;
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 200; guard += 1) {
        const result = await call(connection(), "search_files", {
          limit: 100,
          ...(maxBytes ? { maxBytes } : {}),
          ...(cursor ? { cursor } : {}),
        });
        expect(serialized(result)).toBeLessThanOrEqual(maxBytes ?? BUDGET);
        expect(result.items.length).toBeGreaterThan(0);
        seen.push(...result.items.map((file: any) => file.id));
        if (!result.page.hasMore) break;
        cursor = result.page.nextCursor;
      }
      // Every row once, in order, then Drive's next page.
      expect(seen).toEqual([...rows.map((row) => row.id), "last"]);
      expect(calls.every((entry) => entry.url.searchParams.get("pageSize") === "100")).toBe(true);
    }
    // A direct call may take the whole page at once.
    calls.length = 0;
    const whole = await call(connection(), "search_files", { limit: 100, maxBytes: 4 * 1024 * 1024 });
    expect(whole.items).toHaveLength(100);
    expect(whole.page.hasMore).toBe(true);
  });
});

describe("a cursor resumes only the listing, and the page, it was issued for", () => {
  // A hundred rows of 1,900-character names: a 64 KiB result holds about
  // thirty, so the first call stops mid-page and its cursor resumes by position.
  const ids = Array.from({ length: 100 }, (_, index) => `r${String(index).padStart(2, "0")}`);
  const rowsOf = (order: readonly string[]) => order.map((id) => ({ id, name: `${id}-${"n".repeat(1_900)}` }));
  const SMALL = { maxBytes: 65_536, limit: 100 };

  /** The first page, and its mid-page cursor, read with Drive's original order. */
  async function firstPage(connector: Connector, args: Record<string, unknown> = {}) {
    route = () => ({ body: { files: rowsOf(ids), nextPageToken: "second" } });
    const first = await call(connector, "search_files", { ...SMALL, ...args });
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(ids.length);
    return first;
  }

  it.each([
    ["reordered", (order: string[]) => [...order].reverse()],
    ["missing an id before the resume point", (order: string[]) => order.slice(1)],
  ])("fails conflict, returning nothing, when the page comes back %s", async (_how, change) => {
    const connector = connection();
    const first = await firstPage(connector);
    route = () => ({ body: { files: rowsOf(change([...ids])), nextPageToken: "second" } });
    const failure = await call(connector, "search_files", { ...SMALL, cursor: first.page.nextCursor }).catch(
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "conflict", retryable: false });
    expect(failure.message).toContain("start the listing again without cursor");
  });

  it("INV-3: refuses cursors from another tool, arguments or delegated caller before any request", async () => {
    const connector = connection();
    const mid = (await firstPage(connector, { query: "name contains 'r'" })).page.nextCursor;
    route = () => ({ body: { files: rowsOf(ids.slice(0, 3)), nextPageToken: "second" } });
    const boundary = (await call(connector, "search_files", { limit: 3 })).page.nextCursor;
    calls.length = 0;
    for (const [name, args] of [
      ["search_files", { ...SMALL, query: "name contains 'q'", cursor: mid }],
      ["search_files", { ...SMALL, cursor: mid }],
      ["search_files", { ...SMALL, query: "name contains 'r'", orderBy: "name", cursor: mid }],
      ["search_files", { ...SMALL, query: "name contains 'r'", includeTrashed: true, cursor: mid }],
      ["search_files", { ...SMALL, query: "name contains 'r'", corpora: "allDrives", cursor: mid }],
      ["search_files", { limit: 4, cursor: boundary }],
      ["list_folder_items", { folderId: "root", limit: 3, cursor: boundary }],
      ["list_shared_drives", { limit: 3, cursor: boundary }],
      ["list_permissions", { fileId: "f1", limit: 3, cursor: boundary }],
    ] as const) {
      const failure = await call(connector, name, args).catch((error) => error);
      expect(failure, `${name} ${JSON.stringify(args).slice(0, 60)}`).toMatchObject({ code: "invalid_args" });
      expect(failure.message).toMatch(/different (call|listing)/);
    }
    expect(calls).toEqual([]);

    const delegated = connection({
      subject: (who: AuthenticatedIdentity) => `${who.principal?.id}@org.example`,
    });
    const registry = makeRegistry([delegated], { storage: sharedStorage });
    const callerContext = (id: string) =>
      registry
        .scoped({
          connectorIds: "all",
          caller: {
            authenticated: true,
            identity: {
              actor: { kind: "test-users", id, namespace: "https://identity.test" },
              subject: { namespace: "https://identity.test", id },
              principal: { namespace: "https://identity.test", id },
              interactive: true,
            },
          },
        })
        .contextFor("files", "https://connecta.example");
    route = (request) => {
      const continued = request.url.searchParams.has("pageToken");
      const id = continued ? "second" : "first";
      return {
        body: {
          files: [{ id }],
          drives: [{ id }],
          permissions: [{ id, role: "reader" }],
          ...(continued ? {} : { nextPageToken: "native-next" }),
        },
      };
    };
    for (const [name, args] of [
      ["search_files", { limit: 1 }],
      ["list_folder_items", { folderId: "root", limit: 1 }],
      ["list_shared_drives", { limit: 1 }],
      ["list_permissions", { fileId: "f1", limit: 1 }],
    ] as const) {
      const first = await call(delegated, name, { ...args, maxBytes: 131_072, fields: ["id"] }, callerContext("alice"));
      expect(first.items.map((item: any) => item.id)).toEqual(["first"]);
      expect(first.page.nextCursor).toBeTypeOf("string");
      const continuation = { ...args, cursor: first.page.nextCursor };
      const before = { tokens: tokenCalls, requests: calls.length };
      await expect(call(delegated, name, continuation, callerContext("bob"))).rejects.toMatchObject({
        code: "invalid_args",
      });
      const unsigned = JSON.parse(atob(first.page.nextCursor.replace(/-/g, "+").replace(/_/g, "/"))).c;
      await expect(call(delegated, name, { ...args, cursor: unsigned }, callerContext("alice"))).rejects.toMatchObject({
        code: "invalid_args",
      });
      expect({ tokens: tokenCalls, requests: calls.length }).toEqual(before);
      for (const presentation of [
        { maxBytes: 65_536, fields: ["id"] },
        { maxBytes: 131_072, fields: name === "list_permissions" ? ["id", "role"] : ["id", "name"] },
        {},
      ]) {
        const continued = await call(delegated, name, { ...continuation, ...presentation }, callerContext("alice"));
        expect(continued.items.map((item: any) => item.id)).toEqual(["second"]);
        expect(continued.page).toEqual({ hasMore: false });
      }
    }
  });
});

describe("nothing is lost silently, and nothing outgrows its result", () => {
  describe("the final-size guard", () => {
    it("refuses an oversized read rather than return it", async () => {
      sizing.oversized = (value) => (value as any)?.id === "huge";
      route = () => ({ body: { id: "huge" } });
      const failure = await call(connection(), "get_file", { fileId: "huge" }).catch((error) => error);
      expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(failure.message).toContain("nothing is returned");
      expect(failure.message).toContain("196608");
    });

    it("tells a write that applied to re-read, never to repeat", async () => {
      const restore = installOwnedTransport();
      try {
        sizing.oversized = (value) => (value as any)?.trashed === true;
        route = () => ({ body: { id: "f1", trashed: true } });
        const failure = await call(connection(), "trash_file", { fileId: "f1" }).catch((error) => error);
        expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
        expect(failure.message).toContain("trash_file applied");
        expect(failure.message).toContain("do not repeat the write");
        expect(calls.filter((entry) => entry.method === "PATCH")).toHaveLength(1);
      } finally {
        restore.restore();
      }
    });
  });

  describe("cursors", () => {
    // The widest cursor this connection issues: a page token plus a mid-page
    // position and three fingerprints, base64url within 16,384 characters.

    it("fingerprints Drive's raw ids, so ids alike for 1,100 characters still differ", async () => {
      const prefix = "a".repeat(1_100);
      const page = (suffix: string) =>
        Array.from({ length: 100 }, (_, index) => ({ id: `${prefix}${suffix}${index}`, name: "n".repeat(1_900) }));
      route = () => ({ body: { files: page("x"), nextPageToken: "more" } });
      const connector = connection();
      const first = await call(connector, "search_files", { limit: 100, maxBytes: 65_536 });
      // Malformed ids are left out of the rows and named, never cut to match.
      expect(first.items[0].id).toBeUndefined();
      expect(first.items[0].truncated).toContain("id");
      route = () => ({ body: { files: page("y"), nextPageToken: "more" } });
      await expect(
        call(connector, "search_files", { limit: 100, maxBytes: 65_536, cursor: first.page.nextCursor }),
      ).rejects.toMatchObject({ code: "conflict" });
    });
  });
});
