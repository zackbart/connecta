// The Google Drive connection. Request and result shapes are pinned by
// test/goldens/drive; this suite keeps what the goldens do not reach: bounded
// and ranged reads, cursors, size guards, upload encoding, and refusals.
// Delegation, subjects, and tokens are test/google-workspace-delegation.test.ts;
// what this suite adds is that Drive's two transports act as the same account.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleReasonsOf } from "../_shared/google/workspace.js";
import { drive } from "./index.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";

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
    expect(result.contentTruncated).toBe(true);
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
      expect(result).toMatchObject({ format: "unavailable", contentTruncated: false });
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
      sizing.oversized = (value) => (value as any)?.trashed === true;
      route = () => ({ body: { id: "f1", trashed: true } });
      const failure = await call(connection(), "trash_file", { fileId: "f1" }).catch((error) => error);
      expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(failure.message).toContain("trash_file applied");
      expect(failure.message).toContain("do not repeat the write");
      expect(calls.filter((entry) => entry.method === "PATCH")).toHaveLength(1);
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
      expect(first.files[0].id).toBeUndefined();
      expect(first.files[0].truncatedFields).toContain("id");
      route = () => ({ body: { files: page("y"), nextPageToken: "more" } });
      await expect(
        call(connector, "search_files", { limit: 100, maxBytes: 65_536, cursor: first.page.nextCursor }),
      ).rejects.toMatchObject({ code: "conflict" });
    });
  });
});
