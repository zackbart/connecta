// The Google Drive connection. Request and result shapes are pinned by
// test/goldens/drive; this suite keeps what the goldens do not reach: bounded
// and ranged reads, cursors, size guards, upload encoding, and refusals.
// Delegation, subjects, and tokens are test/google-workspace-delegation.test.ts;
// what this suite adds is that Drive's two transports act as the same account.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCaller } from "../../connector-caller.js";
import { googleReasonsOf } from "../_shared/google/workspace.js";
import { DRIVE_API_BASE_URL, drive } from "./index.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
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

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_BASE_URL = "https://www.googleapis.com/upload/drive/v3";

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
let route: Route = () => undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  sizing.oversized = undefined;
  calls.length = 0;
  tokenCalls = 0;
  route = () => undefined;
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      tokenCalls += 1;
      return Response.json({ access_token: "token", expires_in: 3599 });
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
  return { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" };
}

function call(connector: Connector, name: string, args: Record<string, unknown> = {}, ctx = context()): Promise<any> {
  return connector.callTool(name, args, ctx) as Promise<any>;
}

/** `METHOD /path` of a call, relative to whichever Drive root it went to. */
function line(index: number): string {
  const { method, url } = calls[index]!;
  const full = `${url.origin}${url.pathname}`;
  return full.startsWith(UPLOAD_BASE_URL)
    ? `${method} upload${full.slice(UPLOAD_BASE_URL.length)}`
    : `${method} ${full.slice(DRIVE_API_BASE_URL.length)}`;
}

const GOOGLE_ERROR = (code: number, reason: string, message: string) => ({
  status: code,
  body: { error: { code, message, errors: [{ reason, message }] } },
});

const FILE = {
  id: "f1",
  name: "Budget 2027.xlsx",
  mimeType: "application/vnd.ms-excel",
  parents: ["folder-1"],
  size: "12345",
  modifiedTime: "2026-09-30T12:00:00.000Z",
  webViewLink: "https://drive.google.com/file/d/f1/view",
  trashed: false,
  owners: [{ emailAddress: "treasurer@church.example", displayName: "Treasurer", photoLink: "https://x" }],
  kind: "drive#file",
  iconLink: "https://noise",
};

describe("whose Drive a call acts as", () => {
  function identity(id: string): AuthenticatedIdentity {
    return {
      actor: { kind: "test-users", id, namespace: "https://identity.test" },
      subject: { namespace: "https://identity.test", id },
      principal: { namespace: "https://identity.test", id },
      interactive: true,
    };
  }

  it("maps the caller once per call, on the upload transport as on the API", async () => {
    const mapping = vi.fn((who: AuthenticatedIdentity) => `${who.principal?.id}@church.example`);
    const connector = connection({ subject: mapping });
    route = (request) =>
      request.method === "GET" ? { body: { parents: ["old"] } } : { body: { id: "f1", parents: ["new"] } };
    const ctx = attachCaller(context(), { identity: identity("ann"), authenticated: true });
    await call(connector, "move_file", { fileId: "f1", folderId: "new" }, ctx);
    expect(calls).toHaveLength(2);
    expect(mapping).toHaveBeenCalledTimes(1);

    route = () => ({ body: { id: "f2" } });
    const uploadCtx = attachCaller(context(), { identity: identity("ann"), authenticated: true });
    await call(connector, "create_file", { name: "notes.txt", content: "hi" }, uploadCtx);
    expect(line(2)).toBe("POST upload/files");
    expect(calls[2]!.headers.get("authorization")).toBe("Bearer token");
    expect(mapping).toHaveBeenCalledTimes(2);
  });

  it("refuses an id that would climb out of the files collection", async () => {
    await expect(call(connection(), "get_file", { fileId: "../about" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toEqual([]);
  });
});

describe("finding files (H9, H10)", () => {
  it("refuses a cursor it did not issue, before any request", async () => {
    for (const cursor of ["prev", "bm90LWpzb24", btoa(JSON.stringify(["t", -1, 5])).replace(/=+$/, "")]) {
      await expect(call(connection(), "search_files", { cursor })).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toEqual([]);
  });
});

const serialized = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("reading content", () => {
  function metadata(file: Record<string, unknown>): Route {
    return (request) =>
      request.url.searchParams.get("fields") ? { body: { id: "f1", name: "F", ...file } } : undefined;
  }

  it("names Drive's export limit from Google's reason, never from a guess", async () => {
    const meta = metadata({ mimeType: "application/vnd.google-apps.document", capabilities: { canDownload: true } });
    route = (request) =>
      meta(request) ?? GOOGLE_ERROR(403, "exportSizeLimitExceeded", "This file is too large to be exported.");
    const failure = await call(connection(), "get_file_content", { fileId: "f1" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("larger than Google will export");
    expect(googleReasonsOf(failure)).toContain("exportSizeLimitExceeded");

    // Any other refusal of the same export is passed on as it was mapped,
    // with no export-limit story attached.
    calls.length = 0;
    route = (request) => meta(request) ?? GOOGLE_ERROR(403, "domainPolicy", "Blocked by policy.");
    const policy = await call(connection(), "get_file_content", { fileId: "f1" }).catch((error) => error);
    expect(policy.message).toContain("domain policy");
    expect(policy.message).not.toContain("export");
  });

  /** The body a range-honoring server sends for this request's Range header. */
  function ranged(request: ApiCall, body: Uint8Array): Uint8Array {
    const range = /^bytes=0-(\d+)$/.exec(request.headers.get("range") ?? "");
    return range ? body.subarray(0, Number(range[1]) + 1) : body;
  }

  it("reads only a range of a large text file and marks the cut", async () => {
    const body = new TextEncoder().encode("abcdefghij".repeat(10));
    const meta = metadata({ mimeType: "text/plain", size: "5000000" });
    route = (request) => meta(request) ?? { status: 206, payload: ranged(request, body), contentType: "text/plain" };
    const result = await call(connection(), "get_file_content", { fileId: "f1", maxChars: 10 });
    expect(calls[1]!.headers.get("range")).toBe("bytes=0-44");
    expect(result.contentTruncated).toBe(true);
    expect(result.content).toBe(
      "abcdefghij\n[… truncated: 10 characters of a 5000000-byte file shown; raise maxChars (up to 100000) to read more]",
    );
  });

  /** Drive's answer to a range from byte 0 of a file with no bytes. */
  const EMPTY_RANGE = {
    ...GOOGLE_ERROR(416, "requestedRangeNotSatisfiable", "Request range not satisfiable"),
    headers: { "Content-Range": "bytes */0" },
  };

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
    expect(result.contentTruncated).toBe(true);
    expect(result.content.startsWith("aaaaaaaaaa\n[… truncated: 10 characters")).toBe(true);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThanOrEqual(45 + CHUNK);
  });

  it.each([
    ["metadata said empty", { size: "0" }],
    ["the file emptied after its metadata said 500 bytes", { size: "500" }],
  ])("reads a verified empty text file as empty when %s", async (_when, sized) => {
    const meta = metadata({ mimeType: "text/plain", ...sized });
    route = (request) => meta(request) ?? EMPTY_RANGE;
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    // The range is always sent: no metadata is trusted to skip it.
    expect(calls[1]!.headers.get("range")).toBe("bytes=0-80004");
    expect(result).toMatchObject({ format: "text", content: "", contentTruncated: false });
  });

  /** The file bytes a default binary result holds, read off the range it asks for. */
  async function defaultBinaryLimit(): Promise<number> {
    const meta = metadata({ mimeType: "application/octet-stream" });
    route = (request) => meta(request) ?? { payload: new Uint8Array(1) };
    await call(connection(), "get_file_content", { fileId: "f1" });
    const limit = Number(/^bytes=0-(\d+)$/.exec(calls[calls.length - 1]!.headers.get("range") ?? "")?.[1]);
    calls.length = 0;
    return limit;
  }

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
      expect(result).toMatchObject({ format: "unavailable", contentTruncated: false });
      expect(result.content).toBeUndefined();
      expect(result.note).toContain(said);
    }
  });

  it("returns a binary of exactly what fits by default, and refuses one byte more", async () => {
    const limit = await defaultBinaryLimit();
    const meta = metadata({ mimeType: "application/octet-stream" });
    route = (request) => meta(request) ?? { payload: ranged(request, new Uint8Array(limit).fill(1)) };
    const fits = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(fits.format).toBe("base64");
    expect(atob(fits.content)).toHaveLength(limit);
    expect(serialized(fits)).toBeLessThanOrEqual(196_608);

    route = (request) => meta(request) ?? { payload: ranged(request, new Uint8Array(limit + 1).fill(1)) };
    const over = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(over.format).toBe("unavailable");
  });

  describe("never splits a character", () => {
    const smile = "\u{1F600}";

    it.each([
      ["honors", true],
      ["ignores", false],
    ])("drops a character a byte range cut in half, when the server %s the range", async (_how, honors) => {
      // Three four-byte characters; one character's budget is 8 bytes, and
      // the range asks for 9, which ends inside the third.
      const body = new TextEncoder().encode(smile.repeat(3));
      const meta = metadata({ mimeType: "text/plain", size: "12" });
      route = (request) =>
        meta(request) ?? {
          status: honors ? 206 : 200,
          payload: honors ? ranged(request, body) : body,
          contentType: "text/plain",
        };
      const result = await call(connection(), "get_file_content", { fileId: "f1", maxChars: 1 });
      expect(calls[1]!.headers.get("range")).toBe("bytes=0-8");
      expect(result.content).toBe(
        `${smile}\n[… truncated: 1 characters of a 12-byte file shown; raise maxChars (up to 100000) to read more]`,
      );
      expect(result.content).toBe(result.content.toWellFormed());
      expect(result.content).not.toContain("\uFFFD");
    });
  });

  it.each([
    ["a binary past the cap", { mimeType: "application/pdf", size: String(2 * 1024 * 1024) }, "maxBytes"],
    ["a shortcut", { mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "t9" } }, "t9"],
    [
      "a download-disabled file",
      { mimeType: "text/plain", size: "5", capabilities: { canDownload: false } },
      "disabled download",
    ],
  ])("returns metadata and a marker, never downloading, for %s", async (_kind, file, said) => {
    route = metadata(file);
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ id: "f1", format: "unavailable", contentTruncated: false });
    expect(result.content).toBeUndefined();
    expect(result.note).toContain(said);
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

  it("reads a verified empty binary as empty base64", async () => {
    const meta = metadata({ mimeType: "application/pdf", size: "500" });
    route = (request) => meta(request) ?? EMPTY_RANGE;
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(result).toMatchObject({ format: "base64", content: "", contentTruncated: false });
  });
});

describe("writing files", () => {
  it("INV-9: never resends an upload Google answered with 401, and mints a fresh token for a deliberate repeat", async () => {
    let first = true;
    route = () => {
      if (!first) return { body: { id: "f9" } };
      first = false;
      return GOOGLE_ERROR(401, "authError", "Invalid Credentials");
    };
    const connector = connection();
    await expect(call(connector, "create_file", { name: "a.txt", content: "same bytes" })).rejects.toMatchObject({
      code: "auth_required",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(calls.map((_, index) => line(index))).toEqual(["POST upload/files"]);
    expect(tokenCalls).toBe(1);

    // The refused token is gone: the explicit repeat is one new request on a fresh one.
    await call(connector, "create_file", { name: "a.txt", content: "same bytes" });
    expect(calls.map((_, index) => line(index))).toEqual(["POST upload/files", "POST upload/files"]);
    expect(tokenCalls).toBe(2);
  });

  it("uploads base64 bytes unchanged", async () => {
    route = () => ({ body: { id: "b1" } });
    await call(connection(), "create_file", { name: "x.bin", contentBase64: "AP8Q" });
    const raw = calls[0]!.raw!;
    const marker = new TextEncoder().encode("application/octet-stream\r\n\r\n");
    const start = indexOf(raw, marker) + marker.length;
    expect([...raw.subarray(start, start + 3)]).toEqual([0x00, 0xff, 0x10]);
  });

  it("refuses ambiguous or oversized content before anything is sent", async () => {
    for (const args of [
      { name: "a", content: "x", contentBase64: "AA==" },
      { name: "a", content: "x", mimeType: "application/vnd.google-apps.document" },
      { name: "a", mimeType: "text/plain" },
      { name: "a", contentBase64: btoa("x".repeat(1024 * 1024 + 1)) },
    ]) {
      await expect(call(connection(), "create_file", args)).rejects.toMatchObject({ code: "invalid_args" });
    }
    await expect(
      call(connection(), "create_file", { name: "a", mimeType: "text/plain\r\nX-Evil: 1", content: "x" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toEqual([]);
  });
});

describe("a write that may have landed says what to check before repeating it", () => {
  /** A 200 whose JSON breaks off mid-stream: Google accepted the write. */
  const BROKEN_REPLY = (): Reply => ({
    contentType: "application/json",
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"f'));
        controller.error(new Error("connection reset mid-body"));
      },
    }),
  });

  it.each([
    ["create_file with content", "create_file", { name: "a.txt", content: "x" }, "search_files"],
    ["share_file", "share_file", { fileId: "f1", type: "anyone", role: "reader" }, "list_permissions"],
  ])("%s, when the reply breaks or never comes", async (_label, name, args, check) => {
    for (const reply of [BROKEN_REPLY, (): Reply => ({ network: true })]) {
      route = reply;
      const failure = await call(connection(), name, args).catch((error) => error);
      expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(failure.message).toContain(check);
      // Never told that nothing happened, or to simply retry.
      expect(failure.message).not.toMatch(/nothing was (applied|changed)/i);
    }
    // One request per call: no write is sent twice.
    expect(calls).toHaveLength(2);
  });
});

describe("sharing", () => {
  it("refuses a share whose fields do not fit its type, before any request", async () => {
    for (const args of [
      { type: "user", role: "reader" },
      { type: "anyone", role: "reader", emailAddress: "a@b.example" },
      { type: "domain", role: "reader" },
      { type: "user", role: "reader", emailAddress: "a@b.example", allowFileDiscovery: true },
      { type: "anyone", role: "reader", sendNotificationEmail: true },
      { type: "user", role: "reader", emailAddress: "a@b.example", emailMessage: "hi" },
      { type: "user", role: "owner", emailAddress: "a@b.example" },
    ]) {
      await expect(call(connection(), "share_file", { fileId: "f1", ...args })).rejects.toMatchObject({
        code: "invalid_args",
      });
    }
    expect(calls).toEqual([]);
  });

  it("emails only when asked, with the message", async () => {
    route = () => ({ body: { id: "p1" } });
    await call(connection(), "share_file", {
      fileId: "f1",
      type: "group",
      role: "commenter",
      emailAddress: "elders@church.example",
      sendNotificationEmail: true,
      emailMessage: "For Tuesday.",
    });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({
      sendNotificationEmail: "true",
      emailMessage: "For Tuesday.",
    });
  });
});

describe("every projection is what the output schema declares (H8, H9)", () => {
  // Realistic responses carry every field the provider asks Drive for, and
  // more besides; empty ones are what ProtoJSON sends when Google has nothing
  // to say, empty arrays and all omitted. Either way a result may only carry
  // keys its schema declares, and must carry every key it requires.
  const RICH_FILE = {
    ...FILE,
    driveId: "sd-1",
    description: "Draft budget",
    createdTime: "2026-01-01T00:00:00.000Z",
    lastModifyingUser: { emailAddress: "ann@church.example", displayName: "Ann", me: false },
    shared: true,
    starred: true,
    shortcutDetails: { targetId: "t1", targetMimeType: "application/pdf", targetResourceKey: "k" },
    capabilities: Object.fromEntries(
      ["canEdit", "canComment", "canShare", "canDownload", "canTrash", "canRename", "canAddChildren", "canDelete"].map(
        (name) => [name, true],
      ),
    ),
  };
  const RICH_PERMISSION = {
    id: "p1",
    type: "user",
    role: "writer",
    emailAddress: "ann@church.example",
    domain: "church.example",
    displayName: "Ann",
    allowFileDiscovery: false,
    expirationTime: "2027-01-01T00:00:00.000Z",
    deleted: true,
    pendingOwner: false,
    permissionDetails: [{ inherited: true, inheritedFrom: "folder-1", role: "writer", permissionType: "file" }],
  };
  const rich: Route = (request) => {
    const path = request.url.pathname;
    if (path.endsWith("/export")) return { payload: "a,b\n1,2", contentType: "text/csv" };
    if (path.endsWith("/drives")) {
      return {
        body: { drives: [{ id: "sd-1", name: "Finance", hidden: true, colorRgb: "#000" }], nextPageToken: "d" },
      };
    }
    if (path.includes("/permissions")) {
      return request.method === "GET" && path.endsWith("/permissions")
        ? { body: { permissions: [RICH_PERMISSION], nextPageToken: "p" } }
        : request.method === "DELETE"
          ? { status: 204 }
          : { body: RICH_PERMISSION };
    }
    if (path.endsWith("/files") && request.method === "GET") {
      return { body: { files: [RICH_FILE], incompleteSearch: true, nextPageToken: "n" } };
    }
    if (request.url.searchParams.get("fields")?.startsWith("id,name,mimeType,size,")) {
      return { body: { ...RICH_FILE, mimeType: "application/vnd.google-apps.spreadsheet", size: undefined } };
    }
    return { body: RICH_FILE };
  };
  const empty: Route = (request) => (request.method === "DELETE" ? { status: 204 } : { body: {} });

  const CASES: [string, Record<string, unknown>][] = [
    ["search_files", {}],
    ["list_folder_items", { folderId: "root" }],
    ["get_file", { fileId: "f1" }],
    ["get_file_content", { fileId: "f1" }],
    ["list_permissions", { fileId: "f1" }],
    ["list_shared_drives", {}],
    ["create_folder", { name: "Elders" }],
    ["create_file", { name: "a.txt", content: "x" }],
    ["update_file_content", { fileId: "f1", content: "x", mimeType: "text/plain" }],
    ["update_file", { fileId: "f1", name: "b.txt" }],
    ["move_file", { fileId: "f1", folderId: "folder-2" }],
    ["copy_file", { fileId: "f1" }],
    ["trash_file", { fileId: "f1" }],
    ["restore_file", { fileId: "f1" }],
    ["share_file", { fileId: "f1", type: "anyone", role: "reader" }],
    ["update_permission", { fileId: "f1", permissionId: "p1", role: "reader" }],
    ["delete_permission", { fileId: "f1", permissionId: "p1" }],
  ];

  /** Keys emitted but undeclared, and required keys missing, at every depth. */
  function mismatches(value: unknown, schema: any, path: string, found: string[]): string[] {
    if (Array.isArray(value)) {
      value.forEach((item) => mismatches(item, schema?.items, `${path}[]`, found));
      return found;
    }
    if (!value || typeof value !== "object") return found;
    const properties: Record<string, unknown> = schema?.properties ?? {};
    for (const [key, entry] of Object.entries(value)) {
      if (!(key in properties)) found.push(`${path}.${key} undeclared`);
      else mismatches(entry, properties[key], `${path}.${key}`, found);
    }
    for (const key of schema?.required ?? []) {
      if (!(key in value)) found.push(`${path}.${key} required but missing`);
    }
    return found;
  }

  /**
   * Every string a JSON body carries made far longer than any bound, and every
   * list three times past the cap: ids turn malformed, labels and names are
   * cut, lists are capped — and each loss must be named in a declared field.
   */
  const pathological: Route = (request) => {
    const reply = rich(request);
    if (!reply || reply.body === undefined) return reply;
    const swell = (value: unknown): unknown =>
      typeof value === "string"
        ? `${value}${"\u0001".repeat(1_500)}`
        : Array.isArray(value)
          ? Array.from({ length: 12 }, (_, index) => swell(value[index % value.length]))
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [key, key === "nextPageToken" ? entry : swell(entry)]),
              )
            : value;
    return { ...reply, body: swell(reply.body) };
  };

  it.each([
    ["empty", empty],
    ["pathological", pathological],
  ] as const)("declares every key of a %s response, and omits nothing required", async (_kind, responses) => {
    const connector = connection();
    const schemas = Object.fromEntries(
      (await connector.listTools(context())).map((tool) => [tool.name, tool.outputSchema]),
    );
    route = responses;
    const found: string[] = [];
    for (const [name, args] of CASES) {
      const result = await call(connector, name, args);
      mismatches(result, schemas[name], name, found);
    }
    expect(found).toEqual([]);
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

  it("fits a default search or folder page of the longest names Drive allows", async () => {
    route = () => ({
      body: { files: Array.from({ length: 25 }, (_, index) => worstFile(index)), nextPageToken: "n".repeat(1024) },
    });
    for (const [name, args] of [
      ["search_files", {}],
      ["list_folder_items", { folderId: "root" }],
    ] as const) {
      const result = await call(connection(), name, args);
      expect(result.files).toHaveLength(25);
      expect(result.files[0].truncatedFields).toEqual(["name"]);
      expect(serialized(result), name).toBeLessThanOrEqual(BUDGET);
    }
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
        expect(result.files.length).toBeGreaterThan(0);
        seen.push(...result.files.map((file: any) => file.id));
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
    expect(whole.files).toHaveLength(100);
    expect(whole.page.hasMore).toBe(true);
  });

  it("holds the whole content result, name and metadata included, to maxBytes", async () => {
    // The longest name and the most text the schema allows, all escaped.
    const meta = (mimeType: string) => (request: ApiCall) =>
      request.url.searchParams.get("fields")
        ? { body: { id: "f1", name: worst(32_767), mimeType, size: "999999999" } }
        : undefined;
    for (const mimeType of ["text/plain", "application/vnd.google-apps.document"]) {
      const metaRoute = meta(mimeType);
      route = (request) => metaRoute(request) ?? { payload: worst(250_000), contentType: "text/plain" };
      for (const maxBytes of [undefined, 65_536, 100_000]) {
        const result = await call(connection(), "get_file_content", {
          fileId: "f1",
          maxChars: 100_000,
          ...(maxBytes ? { maxBytes } : {}),
        });
        expect(serialized(result), `${mimeType} ${maxBytes}`).toBeLessThanOrEqual(maxBytes ?? BUDGET);
        expect(result).toMatchObject({ truncatedFields: ["name"], contentTruncated: true });
        expect(result.content).toContain("raise maxBytes");
        expect(result.content).toBe(result.content.toWellFormed());
      }
      // Raised for a direct call, maxChars binds instead.
      const direct = await call(connection(), "get_file_content", {
        fileId: "f1",
        maxChars: 100_000,
        maxBytes: 4 * 1024 * 1024,
      });
      expect(direct.content).toContain("raise maxChars");
      expect(serialized(direct)).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
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
    expect(first.files.length).toBeGreaterThan(0);
    expect(first.files.length).toBeLessThan(ids.length);
    return first;
  }

  it("resumes the unchanged page at the first row left out", async () => {
    const connector = connection();
    const first = await firstPage(connector);
    const second = await call(connector, "search_files", { ...SMALL, cursor: first.page.nextCursor });
    expect(second.files[0].id).toBe(ids[first.files.length]);
    // Resuming re-reads the same Drive page: no token on the first.
    expect(calls[1]!.url.searchParams.get("pageToken")).toBeNull();
  });

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

  it("ends a page whose order keeps changing with conflict, never a loop", async () => {
    let reads = 0;
    route = () => {
      reads += 1;
      // Drive flips between two orders on every read.
      return { body: { files: rowsOf(reads % 2 === 1 ? ids : [...ids].reverse()), nextPageToken: "second" } };
    };
    const connector = connection();
    let cursor: string | undefined;
    let failure: any;
    for (let guard = 0; guard < 10 && failure === undefined; guard += 1) {
      const result = await call(connector, "search_files", { ...SMALL, ...(cursor ? { cursor } : {}) }).catch(
        (error) => error,
      );
      if (result instanceof Error) failure = result;
      else cursor = result.page.nextCursor;
    }
    expect(failure).toMatchObject({ code: "conflict" });
    expect(reads).toBe(2);
  });

  it("refuses a cursor from another tool or other arguments, before any request", async () => {
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
      expect(failure.message).toContain("different listing");
    }
    expect(calls).toEqual([]);
  });

  it("refuses a permissions cursor for another file, and a folder cursor for another folder", async () => {
    const connector = connection();
    route = () => ({ body: { permissions: [{ id: "p1" }, { id: "p2" }], nextPageToken: "more" } });
    const permissions = await call(connector, "list_permissions", { fileId: "f1", limit: 2 });
    await expect(
      call(connector, "list_permissions", { fileId: "f2", limit: 2, cursor: permissions.page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args" });

    route = (request) =>
      request.url.pathname.endsWith("/files")
        ? { body: { files: [{ id: "a" }], nextPageToken: "more" } }
        : { body: { id: "x", mimeType: "application/vnd.google-apps.folder" } };
    const folder = await call(connector, "list_folder_items", { folderId: "folder-a", limit: 1 });
    calls.length = 0;
    await expect(
      call(connector, "list_folder_items", { folderId: "folder-b", limit: 1, cursor: folder.page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    // Only the folder lookup that tells its drive; never the listing.
    expect(calls.map((_, index) => line(index))).toEqual(["GET /files/folder-b"]);
  });

  it("lets maxBytes change between pages, since it only decides where a page stops", async () => {
    const connector = connection();
    const first = await firstPage(connector);
    const rest = await call(connector, "search_files", {
      limit: 100,
      maxBytes: 4 * 1024 * 1024,
      cursor: first.page.nextCursor,
    });
    expect(rest.files[0].id).toBe(ids[first.files.length]);
    expect(first.files.length + rest.files.length).toBe(ids.length);
  });
});

describe("nothing is lost silently, and nothing outgrows its result", () => {
  it("names every cut, capped, or dropped field, and keeps identifiers whole or out", async () => {
    route = () => ({
      body: {
        id: "f1",
        name: "Wait…",
        parents: ["ok-parent", "bad parent!", ...Array.from({ length: 11 }, (_, index) => `p${index}`)],
        owners: Array.from({ length: 12 }, (_, index) => ({ emailAddress: `owner${index}@church.example` })),
        webViewLink: `https://drive.google.com/${"x".repeat(5_000)}`,
        shortcutDetails: { targetId: "t".repeat(300) },
      },
    });
    const file = await call(connection(), "get_file", { fileId: "f1" });
    // A real ellipsis in a name is not a cut.
    expect(file.name).toBe("Wait…");
    expect(file.parents).toEqual(["ok-parent", ...Array.from({ length: 9 }, (_, index) => `p${index}`)]);
    expect(file.owners).toHaveLength(10);
    expect(file.webViewLink.endsWith("…")).toBe(true);
    expect(file.shortcutTargetId).toBeUndefined();
    expect([...file.truncatedFields].sort()).toEqual(["owners", "parents", "shortcutTargetId", "webViewLink"]);

    route = () => ({ body: { id: "f1", name: "Budget" } });
    expect((await call(connection(), "get_file", { fileId: "f1" })).truncatedFields).toBeUndefined();
  });

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
      sizing.oversized = (value) => (value as any)?.trashed === true;
      route = () => ({ body: { id: "f1", trashed: true } });
      const failure = await call(connection(), "trash_file", { fileId: "f1" }).catch((error) => error);
      expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(failure.message).toContain("trash_file applied");
      expect(failure.message).toContain("do not repeat the write");
      expect(calls.filter((entry) => entry.method === "PATCH")).toHaveLength(1);
    });

    it("wraps every tool", async () => {
      sizing.oversized = () => true;
      const connector = connection();
      route = (request) =>
        request.method === "DELETE"
          ? { status: 204 }
          : request.url.searchParams.get("alt") === "media"
            ? { payload: "x", contentType: "text/plain" }
            : { body: { id: "f1", mimeType: "text/plain", size: "1", parents: ["p"] } };
      const names = (await connector.listTools(context())).map((tool) => tool.name);
      const ARGS: Record<string, Record<string, unknown>> = {
        search_files: {},
        list_folder_items: { folderId: "root" },
        get_file: { fileId: "f1" },
        get_file_content: { fileId: "f1" },
        list_permissions: { fileId: "f1" },
        list_shared_drives: {},
        create_folder: { name: "a" },
        create_file: { name: "a", content: "x" },
        update_file_content: { fileId: "f1", content: "x", mimeType: "text/plain" },
        update_file: { fileId: "f1", name: "b" },
        move_file: { fileId: "f1", folderId: "p2" },
        copy_file: { fileId: "f1" },
        trash_file: { fileId: "f1" },
        restore_file: { fileId: "f1" },
        share_file: { fileId: "f1", type: "anyone", role: "reader" },
        update_permission: { fileId: "f1", permissionId: "p1", role: "reader" },
        delete_permission: { fileId: "f1", permissionId: "p1" },
      };
      expect(Object.keys(ARGS).sort()).toEqual([...names].sort());
      for (const name of names) {
        const failure = await call(connector, name, ARGS[name]).catch((error) => error);
        expect(failure, name).toBeInstanceOf(Error);
        expect(failure.code, name).toBe("connector_call_failed");
      }
    });
  });

  describe("cursors", () => {
    // The widest cursor this connection issues: a page token plus a mid-page
    // position and three fingerprints, base64url within 16,384 characters.
    const overhead = JSON.stringify(["", 100, 100, "A".repeat(16), "A".repeat(16), "A".repeat(16)]).length;
    const LONGEST_TOKEN = (16_384 * 3) / 4 - overhead;

    it("refuses to issue a cursor it could not accept back, and says why", async () => {
      route = () => ({ body: { files: [{ id: "a" }], nextPageToken: "t".repeat(LONGEST_TOKEN + 1) } });
      const failure = await call(connection(), "search_files", { limit: 100 }).catch((error) => error);
      expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(failure.message).toContain("too long for a cursor");
    });

    it("fingerprints Drive's raw ids, so ids alike for 1,100 characters still differ", async () => {
      const prefix = "a".repeat(1_100);
      const page = (suffix: string) =>
        Array.from({ length: 100 }, (_, index) => ({ id: `${prefix}${suffix}${index}`, name: "n".repeat(1_900) }));
      route = () => ({ body: { files: page("x"), nextPageToken: "more" } });
      const connector = connection();
      const first = await call(connector, "search_files", { limit: 100, maxBytes: 65_536 });
      // Malformed ids are left out of the rows and named, never cut to match.
      expect(first.files[0].id).toBeUndefined();
      expect(first.files[0].truncatedFields).toContain("id");
      route = () => ({ body: { files: page("y"), nextPageToken: "more" } });
      await expect(
        call(connector, "search_files", { limit: 100, maxBytes: 65_536, cursor: first.page.nextCursor }),
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("replays a cursor carrying the longest page token it accepts, at a boundary and mid-page", async () => {
      const token = "t".repeat(LONGEST_TOKEN);
      const rows = Array.from({ length: 100 }, (_, index) => ({ id: `r${index}`, name: "n".repeat(1_900) }));
      route = (request) =>
        request.url.searchParams.get("pageToken") === token
          ? { body: { files: rows } }
          : { body: { files: [{ id: "a" }], nextPageToken: token } };
      const connector = connection();
      const first = await call(connector, "search_files", { limit: 100 });
      expect(first.page.nextCursor.length).toBeLessThanOrEqual(16_384);
      const second = await call(connector, "search_files", {
        limit: 100,
        maxBytes: 65_536,
        cursor: first.page.nextCursor,
      });
      expect(calls[1]!.url.searchParams.get("pageToken")).toBe(token);
      // Mid-page, beside a full page of rows: the widest cursor there is.
      expect(second.page.nextCursor.length).toBeLessThanOrEqual(16_384);
      expect(new TextEncoder().encode(JSON.stringify(second)).length).toBeLessThanOrEqual(65_536);
      const third = await call(connector, "search_files", {
        limit: 100,
        maxBytes: 65_536,
        cursor: second.page.nextCursor,
      });
      expect(third.files[0].id).toBe(rows[second.files.length]!.id);
    });
  });
});

describe("a redirected write never claims an outcome (shared update #4)", () => {
  const REDIRECT: Reply = { status: 302, headers: { Location: "https://elsewhere.example/upload" }, body: {} };
  /** Each write, its arguments, and the read it names before a repeat, if any. */
  const WRITES: [string, Record<string, unknown>, string | undefined][] = [
    ["create_file", { name: "a.txt", content: "x" }, "search_files"],
    ["move_file", { fileId: "f1", folderId: "p2" }, undefined],
  ];

  it.each(WRITES)(
    "a 3xx to %s leaves its outcome unknown, never applied, and is not followed",
    async (name, args, check) => {
      route = (request) => (request.method === "GET" ? { body: { id: "f1", parents: ["p1"] } } : REDIRECT);
      const failure = await call(connection(), name, args).catch((error) => error);
      expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(failure.message).toContain("unknown");
      expect(failure.message).not.toMatch(/probably applied|nothing was (applied|changed)/i);
      // The guard's word, said only after a recorded 2xx, never here.
      expect(failure.message).not.toContain(`${name} applied`);
      if (check) expect(failure.message).toContain(check);
      else expect(failure.message).not.toMatch(/search_files|list_permissions|second copy/);
      // Sent once, and never to the redirect's host.
      expect(calls.filter((entry) => entry.method !== "GET")).toHaveLength(1);
      expect(calls.every((entry) => entry.url.hostname === "www.googleapis.com")).toBe(true);
    },
  );
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}
