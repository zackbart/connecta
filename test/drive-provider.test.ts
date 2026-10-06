// The Google Drive connection. Tests stub the network and pin the requests
// each tool sends, the projections it returns, the uploads it frames, and the
// surface it refuses to have — H1, H9, H10, H11, and H14 for this provider.
// Delegation, subjects, and tokens are test/google-workspace-delegation.test.ts;
// what this suite adds is that Drive's two transports act as the same account.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCaller } from "../src/connector-caller.js";
import { googleReasonsOf } from "../src/providers/google/workspace.js";
import { DRIVE_API_BASE_URL, DRIVE_SCOPES, drive } from "../src/providers/drive.js";
import { memoryStorage } from "../src/storage/memory.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import { silentLogger } from "./helpers.js";
import type {
  AuthenticatedIdentity,
  Connector,
  ConnectorContext,
  ConnectorUsageGuide,
} from "../src/types.js";

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
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200, ...(reply.headers ? { headers: reply.headers } : {}) });
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

function guide(connector: Connector): ConnectorUsageGuide {
  if (typeof connector.usageGuide !== "object" || !connector.usageGuide) {
    throw new Error("expected a structured guide");
  }
  return connector.usageGuide;
}

/** `METHOD /path` of a call, relative to whichever Drive root it went to. */
function line(index: number): string {
  const { method, url } = calls[index]!;
  const full = `${url.origin}${url.pathname}`;
  return full.startsWith(UPLOAD_BASE_URL)
    ? `${method} upload${full.slice(UPLOAD_BASE_URL.length)}`
    : `${method} ${full.slice(DRIVE_API_BASE_URL.length)}`;
}

function query(index: number): Record<string, string> {
  return Object.fromEntries(calls[index]!.url.searchParams);
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

describe("drive() identity and surface (H1, H14)", () => {
  it("requires a purpose and names the routing fact in title, description, and guide", () => {
    expect(() => connection({ purpose: "" })).toThrow(/purpose/);
    const connector = connection({ instructions: "Shared drive Finance is read-mostly." });
    expect(connector.title).toBe("Google Drive");
    expect(connector.description).toContain("never delete them for good");
    expect(connector.description).toContain("Church staff documents");
    const content = guide(connector).content;
    expect(content.split("\n").find((entry) => entry && !entry.startsWith("#"))).toMatch(/own Google Drive/);
    expect(content).toContain("## Connection instructions\n\nShared drive Finance is read-mostly.");
    expect(guide(connector).required).toBe(true);
  });

  it("has no permanent delete, no empty trash, no ownership transfer, and no raw hatch", async () => {
    const tools = await connection().listTools(context());
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "copy_file",
      "create_file",
      "create_folder",
      "delete_permission",
      "get_file",
      "get_file_content",
      "list_folder_items",
      "list_permissions",
      "list_shared_drives",
      "move_file",
      "restore_file",
      "search_files",
      "share_file",
      "trash_file",
      "update_file",
      "update_file_content",
      "update_permission",
    ]);
    expect(tools.some((tool) => /delete_file|empty|transfer|owner|drive_api/.test(tool.name))).toBe(false);
    // No role argument can make anyone an owner.
    for (const name of ["share_file", "update_permission"]) {
      const role = (tools.find((tool) => tool.name === name)!.inputSchema as any).properties.role;
      expect(role.enum).not.toContain("owner");
    }
  });

  it("classifies reads, additive writes, and destructive writes, and never exempts itself", async () => {
    const connector = connection();
    const tools = await connector.listTools(context());
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const reads = tools.filter((tool) => isExplicitlyReadOnly(tool)).map((tool) => tool.name).sort();
    expect(reads).toEqual([
      "get_file",
      "get_file_content",
      "list_folder_items",
      "list_permissions",
      "list_shared_drives",
      "search_files",
    ]);
    for (const name of reads) expect(byName[name]!.annotations).toEqual({ readOnlyHint: true });
    for (const name of ["create_folder", "restore_file"]) {
      expect(byName[name]!.annotations, name).toEqual({ readOnlyHint: false, destructiveHint: false });
    }
    // A new file takes its folder's sharing, so creating or copying one into
    // a shared folder discloses it: approved like move_file, never additive.
    for (const name of [
      "create_file",
      "copy_file",
      "update_file_content",
      "update_file",
      "move_file",
      "trash_file",
      "share_file",
      "update_permission",
      "delete_permission",
    ]) {
      expect(byName[name]!.annotations, name).toEqual({ readOnlyHint: false, destructiveHint: true });
    }
    expect(connector.approval).toBeUndefined();
    expect(connector.credential).toBeUndefined();
    expect(connector.startAuth).toBeUndefined();
  });

  it("requests exactly the drive scope", () => {
    expect([...DRIVE_SCOPES]).toEqual(["https://www.googleapis.com/auth/drive"]);
  });
});

describe("whose Drive a call acts as", () => {
  function identity(id: string): AuthenticatedIdentity {
    return {
      actor: { kind: "test-users", id, namespace: "https://identity.test" },
      subject: { namespace: "https://identity.test", id },
      principal: { namespace: "https://identity.test", id },
      interactive: true,
    };
  }

  it("fails auth_required with no admitted caller, before any network call", async () => {
    const connector = connection({ subject: (who: AuthenticatedIdentity) => `${who.principal?.id}@church.example` });
    await expect(call(connector, "get_file", { fileId: "f1" })).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("no admitted caller"),
    });
    await expect(
      call(connector, "create_file", { name: "a.txt", content: "x" }),
    ).rejects.toMatchObject({ code: "auth_required" });
    expect(tokenCalls).toBe(0);
    expect(calls).toEqual([]);
  });

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
  it("searches with Drive syntax, leaving trash out, and projects each file", async () => {
    route = () => ({ body: { files: [FILE], nextPageToken: "next-1", incompleteSearch: true, kind: "drive#fileList" } });
    const args = { query: "name contains 'budget'", orderBy: "modifiedTime desc", limit: 5 };
    const result = await call(connection(), "search_files", args);
    expect(line(0)).toBe("GET /files");
    const sent = query(0);
    expect(sent).toMatchObject({
      q: "(name contains 'budget') and trashed = false",
      corpora: "user",
      orderBy: "modifiedTime desc",
      pageSize: "5",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    expect(sent["pageToken"]).toBeUndefined();
    expect(sent["fields"]).toMatch(/^nextPageToken,incompleteSearch,files\(id,name,mimeType,/);
    expect(result).toEqual({
      files: [
        {
          id: "f1",
          name: "Budget 2027.xlsx",
          mimeType: "application/vnd.ms-excel",
          parents: ["folder-1"],
          size: 12345,
          modifiedTime: "2026-09-30T12:00:00.000Z",
          owners: ["treasurer@church.example"],
          trashed: false,
          webViewLink: "https://drive.google.com/file/d/f1/view",
        },
      ],
      incompleteSearch: true,
      page: { hasMore: true, nextCursor: expect.stringMatching(/^[A-Za-z0-9_-]+$/) },
    });
    expect(JSON.stringify(result)).not.toContain("noise");

    // The cursor carries Drive's next token and the page size it was read with.
    await call(connection(), "search_files", { ...args, cursor: result.page.nextCursor });
    expect(query(1)).toMatchObject({ pageToken: "next-1", pageSize: "5" });
  });

  it("refuses a cursor it did not issue, before any request", async () => {
    for (const cursor of ["prev", "bm90LWpzb24", btoa(JSON.stringify(["t", -1, 5])).replace(/=+$/, "")]) {
      await expect(call(connection(), "search_files", { cursor })).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toEqual([]);
  });

  it("ends paging with one branchable signal and searches everything by default", async () => {
    route = () => ({ body: {} });
    const result = await call(connection(), "search_files");
    expect(result).toEqual({ files: [], page: { hasMore: false, nextCursor: null } });
    expect(query(0)).toMatchObject({ q: "trashed = false", pageSize: "25" });
    expect(query(0)["orderBy"]).toBeUndefined();

    calls.length = 0;
    await call(connection(), "search_files", { query: "starred", includeTrashed: true });
    expect(query(0)["q"]).toBe("starred");
  });

  it("searches one shared drive by id, and refuses a driveId without corpora drive", async () => {
    route = () => ({ body: {} });
    await call(connection(), "search_files", { corpora: "drive", driveId: "sd-1" });
    expect(query(0)).toMatchObject({ corpora: "drive", driveId: "sd-1" });
    calls.length = 0;
    for (const args of [{ driveId: "sd-1" }, { corpora: "drive" }]) {
      await expect(call(connection(), "search_files", args)).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toEqual([]);
  });

  it("lists a shared drive folder within its drive, folders first", async () => {
    route = (request) =>
      request.url.pathname.endsWith("/files/folder-1")
        ? { body: { id: "folder-1", mimeType: "application/vnd.google-apps.folder", driveId: "sd-1" } }
        : { body: { files: [{ id: "f2", name: "Minutes", mimeType: "application/vnd.google-apps.document" }] } };
    const result = await call(connection(), "list_folder_items", { folderId: "folder-1" });
    expect(line(0)).toBe("GET /files/folder-1");
    expect(query(1)).toMatchObject({
      q: "'folder-1' in parents and trashed = false",
      corpora: "drive",
      driveId: "sd-1",
      orderBy: "folder,name",
    });
    expect(result.files).toEqual([{ id: "f2", name: "Minutes", mimeType: "application/vnd.google-apps.document" }]);
  });

  it("lists My Drive's root without a lookup, and refuses a file as a folder", async () => {
    route = () => ({ body: {} });
    await call(connection(), "list_folder_items", { folderId: "root" });
    expect(calls).toHaveLength(1);
    expect(query(0)).toMatchObject({ q: "'root' in parents and trashed = false", corpora: "user" });

    calls.length = 0;
    route = () => ({ body: { id: "f1", mimeType: "application/pdf" } });
    await expect(call(connection(), "list_folder_items", { folderId: "f1" })).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("not a folder"),
    });
    expect(calls).toHaveLength(1);
  });

  it("gets a file's metadata with what this user may do", async () => {
    route = () => ({
      body: {
        ...FILE,
        description: "Draft budget",
        createdTime: "2026-01-01T00:00:00.000Z",
        lastModifyingUser: { emailAddress: "ann@church.example", displayName: "Ann" },
        shared: true,
        starred: false,
        capabilities: { canEdit: true, canShare: false, canDownload: true, canChangeSecurityUpdateEnabled: false },
      },
    });
    const result = await call(connection(), "get_file", { fileId: "f1" });
    expect(line(0)).toBe("GET /files/f1");
    expect(query(0)["fields"]).toContain("capabilities(");
    expect(result).toMatchObject({
      id: "f1",
      description: "Draft budget",
      modifiedBy: "ann@church.example",
      shared: true,
      starred: false,
      capabilities: { canEdit: true, canShare: false, canDownload: true },
    });
    expect(result.capabilities.canChangeSecurityUpdateEnabled).toBeUndefined();
  });

  it("lists shared drives and permissions, paged", async () => {
    route = () => ({ body: { drives: [{ id: "sd-1", name: "Finance", hidden: false, kind: "drive#drive" }], nextPageToken: "d2" } });
    const drives = await call(connection(), "list_shared_drives", { query: "name contains 'Fin'" });
    expect(line(0)).toBe("GET /drives");
    expect(query(0)).toMatchObject({ q: "name contains 'Fin'", pageSize: "25" });
    expect(drives).toMatchObject({ drives: [{ id: "sd-1", name: "Finance" }], page: { hasMore: true } });
    await call(connection(), "list_shared_drives", { query: "name contains 'Fin'", cursor: drives.page.nextCursor });
    expect(query(1)).toMatchObject({ pageToken: "d2", pageSize: "25" });

    calls.length = 0;
    route = () => ({
      body: {
        permissions: [
          { id: "p1", type: "user", role: "writer", emailAddress: "ann@church.example", displayName: "Ann", photoLink: "x" },
          { id: "anyoneWithLink", type: "anyone", role: "reader", allowFileDiscovery: false },
          { id: "p3", type: "group", role: "organizer", emailAddress: "staff@church.example", permissionDetails: [{ inherited: true }] },
        ],
      },
    });
    const permissions = await call(connection(), "list_permissions", { fileId: "f1", limit: 50 });
    expect(line(0)).toBe("GET /files/f1/permissions");
    expect(query(0)).toMatchObject({ pageSize: "50", supportsAllDrives: "true" });
    expect(permissions).toEqual({
      permissions: [
        { id: "p1", type: "user", role: "writer", emailAddress: "ann@church.example", displayName: "Ann" },
        { id: "anyoneWithLink", type: "anyone", role: "reader", allowFileDiscovery: false },
        { id: "p3", type: "group", role: "organizer", emailAddress: "staff@church.example", inherited: true },
      ],
      page: { hasMore: false, nextCursor: null },
    });
  });
});

const serialized = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("reading content", () => {
  function metadata(file: Record<string, unknown>): Route {
    return (request) =>
      request.url.searchParams.get("fields") ? { body: { id: "f1", name: "F", ...file } } : undefined;
  }

  it("exports a Google Doc as Markdown", async () => {
    const meta = metadata({ mimeType: "application/vnd.google-apps.document", capabilities: { canDownload: true } });
    route = (request) =>
      meta(request) ?? { payload: "# Elders\n\nAgenda.", contentType: "text/markdown; charset=utf-8" };
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(line(1)).toBe("GET /files/f1/export");
    expect(query(1)).toEqual({ mimeType: "text/markdown" });
    expect(calls[1]!.headers.get("accept")).toBe("text/markdown");
    expect(result).toMatchObject({
      id: "f1",
      format: "markdown",
      exportedAs: "text/markdown",
      content: "# Elders\n\nAgenda.",
      contentTruncated: false,
    });
  });

  it("exports a Sheet as CSV of the first sheet, and says so", async () => {
    const meta = metadata({ mimeType: "application/vnd.google-apps.spreadsheet" });
    route = (request) => meta(request) ?? { payload: "a,b\n1,2\n", contentType: "text/csv" };
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(query(1)).toEqual({ mimeType: "text/csv" });
    expect(result).toMatchObject({ format: "csv", content: "a,b\n1,2\n" });
    expect(result.note).toContain("first sheet only");
  });

  it("exports Slides as plain text and caps it with an explicit marker", async () => {
    const meta = metadata({ mimeType: "application/vnd.google-apps.presentation" });
    route = (request) => meta(request) ?? { payload: "Slide one\nSlide two", contentType: "text/plain" };
    const result = await call(connection(), "get_file_content", { fileId: "f1", maxChars: 9 });
    expect(query(1)).toEqual({ mimeType: "text/plain" });
    expect(result.format).toBe("text");
    expect(result.contentTruncated).toBe(true);
    expect(result.content).toBe(
      "Slide one\n[… truncated: 9 characters of 19 characters shown; raise maxChars (up to 100000) to read more]",
    );
  });

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

  it("reads a small text file whole, asking for one byte past what it keeps", async () => {
    const meta = metadata({ mimeType: "application/json", size: "17" });
    route = (request) => meta(request) ?? { payload: '{"ok":true,"n":1}', contentType: "application/json" };
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(line(1)).toBe("GET /files/f1");
    expect(query(1)).toMatchObject({ alt: "media" });
    // 20,000 characters at four bytes each, plus one character, plus one byte.
    expect(calls[1]!.headers.get("range")).toBe("bytes=0-80004");
    expect(result).toMatchObject({ format: "text", content: '{"ok":true,"n":1}', contentTruncated: false, size: 17 });
  });

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

  it("cuts a text file that grew past its metadata, even from a server that ignores the range", async () => {
    // Metadata is a separate read; the file can change before the download.
    const meta = metadata({ mimeType: "text/plain", size: "5" });
    route = (request) => meta(request) ?? { payload: "x".repeat(100_000), contentType: "text/plain" };
    const result = await call(connection(), "get_file_content", { fileId: "f1", maxChars: 10 });
    expect(calls[1]!.headers.get("range")).toBe("bytes=0-44");
    expect(result.contentTruncated).toBe(true);
    expect(result.content.startsWith(`${"x".repeat(10)}\n[… truncated: 10 characters of a 5-byte file`)).toBe(true);
  });

  /** Drive's answer to a range from byte 0 of a file with no bytes. */
  const EMPTY_RANGE = {
    ...GOOGLE_ERROR(416, "requestedRangeNotSatisfiable", "Request range not satisfiable"),
    headers: { "Content-Range": "bytes */0" },
  };

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

  /**
   * A body of `total` bytes of `fill`, produced only as it is read, that
   * records how much was pulled and whether the reader gave up on the rest.
   */
  function lazyBody(total: number, fill: number) {
    const CHUNK = 64 * 1024;
    const seen = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
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
    }, { highWaterMark: 0 });
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

  it("stops a binary that ignored its range at the cap, and cancels the rest unread", async () => {
    const { stream, seen, CHUNK } = lazyBody(2 * 1024 * 1024, 7);
    const meta = metadata({ mimeType: "application/pdf", size: "1" });
    route = (request) => meta(request) ?? { stream, contentType: "application/pdf" };
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(result.format).toBe("unavailable");
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThanOrEqual(147_456 + CHUNK);
  });

  it.each([
    ["metadata said empty", { size: "0" }],
    ["the file emptied after its metadata said 500 bytes", { size: "500" }],
    ["metadata gave no size", {}],
  ])("reads a verified empty text file as empty when %s", async (_when, sized) => {
    const meta = metadata({ mimeType: "text/plain", ...sized });
    route = (request) => meta(request) ?? EMPTY_RANGE;
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    // The range is always sent: no metadata is trusted to skip it.
    expect(calls[1]!.headers.get("range")).toBe("bytes=0-80004");
    expect(result).toMatchObject({ format: "text", content: "", contentTruncated: false });
  });

  it("reads a verified empty binary as empty base64", async () => {
    const meta = metadata({ mimeType: "application/pdf", size: "500" });
    route = (request) => meta(request) ?? EMPTY_RANGE;
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(result).toMatchObject({ format: "base64", content: "", contentTruncated: false });
  });

  it("still caps a file whose metadata said empty but which has grown", async () => {
    const meta = metadata({ mimeType: "text/plain", size: "0" });
    route = (request) => meta(request) ?? { payload: "y".repeat(100), contentType: "text/plain" };
    const result = await call(connection(), "get_file_content", { fileId: "f1", maxChars: 10 });
    expect(calls[1]!.headers.get("range")).toBe("bytes=0-44");
    expect(result.contentTruncated).toBe(true);
  });

  it("passes on any other refusal of a range read", async () => {
    const meta = metadata({ mimeType: "text/plain", size: "5" });
    route = (request) => meta(request) ?? GOOGLE_ERROR(403, "cannotDownloadAbusiveFile", "Flagged as abusive.");
    await expect(call(connection(), "get_file_content", { fileId: "f1" })).rejects.toMatchObject({
      code: "connector_call_failed",
    });
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

  it("returns a small binary as base64, asking for one byte past what fits", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const meta = metadata({ mimeType: "application/pdf", size: "6" });
    route = (request) => meta(request) ?? { payload: bytes, contentType: "application/pdf" };
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    // Base64 of what fits 192 KiB beside the envelope: a little under 144 KiB.
    const asked = Number(/^bytes=0-(\d+)$/.exec(calls[1]!.headers.get("range") ?? "")?.[1]);
    expect(asked).toBeGreaterThan(140_000);
    expect(asked).toBeLessThanOrEqual(147_456);
    expect(result).toMatchObject({ format: "base64", content: "JVBERgD/", contentTruncated: false });
  });

  it.each([
    ["honors", true],
    ["ignores", false],
  ])("holds a binary to the cap when metadata understated it and the server %s the range", async (_how, honors) => {
    // Metadata said one byte; the download is 2 MiB.
    const body = new Uint8Array(2 * 1024 * 1024).fill(7);
    const meta = metadata({ mimeType: "application/pdf", size: "1" });
    route = (request) =>
      meta(request) ?? { status: honors ? 206 : 200, payload: honors ? ranged(request, body) : body, contentType: "application/pdf" };
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

  it("returns 1 MiB, the connection's cap, only with maxBytes raised for a direct call", async () => {
    const body = new Uint8Array(1024 * 1024).fill(1);
    const meta = metadata({ mimeType: "application/octet-stream" });
    route = (request) => meta(request) ?? { payload: ranged(request, body) };
    const result = await call(connection(), "get_file_content", { fileId: "f1", maxBytes: 4 * 1024 * 1024 });
    expect(result.format).toBe("base64");
    expect(atob(result.content)).toHaveLength(1024 * 1024);
    expect(calls[1]!.headers.get("range")).toBe("bytes=0-1048576");
  });

  it("says how to raise maxBytes when a binary is past the default", async () => {
    route = metadata({ mimeType: "application/pdf", size: String(200 * 1024) });
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(calls).toHaveLength(1);
    expect(result.note).toContain("maxBytes (196608)");
    expect(result.note).toContain("direct call_tool only");
  });

  describe("never splits a character", () => {
    const smile = "\u{1F600}";

    it("counts characters as code points when it cuts an export", async () => {
      const meta = metadata({ mimeType: "application/vnd.google-apps.presentation" });
      route = (request) => meta(request) ?? { payload: `${smile}x${smile}`, contentType: "text/plain; charset=utf-8" };
      const result = await call(connection(), "get_file_content", { fileId: "f1", maxChars: 1 });
      expect(result.content).toBe(
        `${smile}\n[… truncated: 1 characters of 3 characters shown; raise maxChars (up to 100000) to read more]`,
      );
      expect(result.content).toBe(result.content.toWellFormed());

      calls.length = 0;
      const whole = await call(connection(), "get_file_content", { fileId: "f1", maxChars: 3 });
      expect(whole).toMatchObject({ content: `${smile}x${smile}`, contentTruncated: false });
    });

    it.each([
      ["honors", true],
      ["ignores", false],
    ])("drops a character a byte range cut in half, when the server %s the range", async (_how, honors) => {
      // Three four-byte characters; one character's budget is 8 bytes, and
      // the range asks for 9, which ends inside the third.
      const body = new TextEncoder().encode(smile.repeat(3));
      const meta = metadata({ mimeType: "text/plain", size: "12" });
      route = (request) =>
        meta(request) ?? { status: honors ? 206 : 200, payload: honors ? ranged(request, body) : body, contentType: "text/plain" };
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
    ["a folder", { mimeType: "application/vnd.google-apps.folder" }, "list_folder_items"],
    ["a drawing", { mimeType: "application/vnd.google-apps.drawing" }, "Drawings"],
    ["a form", { mimeType: "application/vnd.google-apps.form" }, "exports no text"],
    ["a shortcut", { mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "t9" } }, "t9"],
    ["a download-disabled file", { mimeType: "text/plain", size: "5", capabilities: { canDownload: false } }, "disabled download"],
  ])("returns metadata and a marker, never downloading, for %s", async (_kind, file, said) => {
    route = metadata(file);
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ id: "f1", format: "unavailable", contentTruncated: false });
    expect(result.content).toBeUndefined();
    expect(result.note).toContain(said);
  });
});

describe("errors map to what the caller does next (H11)", () => {
  it("states that a 404 may be a file this account cannot see", async () => {
    route = () => GOOGLE_ERROR(404, "notFound", "File not found: f1.");
    const failure = await call(connection(), "get_file", { fileId: "f1" }).catch((error) => error);
    expect(failure.code).toBe("connector_call_failed");
    expect(failure.message).toContain("not visible to this account");
  });

  it("names the drive scope when the grant lacks it", async () => {
    route = () => GOOGLE_ERROR(403, "insufficientPermissions", "Insufficient Permission");
    const failure = await call(connection(), "search_files").catch((error) => error);
    expect(failure.code).toBe("auth_required");
    expect(failure.message).toContain("https://www.googleapis.com/auth/drive");
  });

  it("says to enable the Google Drive API, and passes on rate limits", async () => {
    route = () => GOOGLE_ERROR(403, "accessNotConfigured", "Drive API has not been used");
    const disabled = await call(connection(), "search_files").catch((error) => error);
    expect(disabled.message).toContain("Google Drive API is not enabled");
    route = () => GOOGLE_ERROR(403, "userRateLimitExceeded", "slow down");
    await expect(call(connection(), "search_files")).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("writing files", () => {
  function decode(bytes: Uint8Array | undefined): string {
    return new TextDecoder().decode(bytes);
  }

  it("creates a folder", async () => {
    route = () => ({ body: { id: "new", name: "Elders", mimeType: "application/vnd.google-apps.folder" } });
    const result = await call(connection(), "create_folder", { name: "Elders", parentId: "folder-1" });
    expect(line(0)).toBe("POST /files");
    expect(calls[0]!.body).toEqual({
      name: "Elders",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["folder-1"],
    });
    expect(result).toEqual({ id: "new", name: "Elders", mimeType: "application/vnd.google-apps.folder" });
  });

  it("uploads text content as one multipart body to the upload host", async () => {
    route = () => ({ body: { id: "f9", name: "notes.md", mimeType: "text/markdown" } });
    const result = await call(connection(), "create_file", {
      name: "notes.md",
      parentId: "folder-1",
      content: "# Notes — café",
      mimeType: "text/markdown",
    });
    expect(line(0)).toBe("POST upload/files");
    expect(query(0)).toMatchObject({ uploadType: "multipart", supportsAllDrives: "true" });
    const contentType = calls[0]!.headers.get("content-type")!;
    const boundary = /^multipart\/related; boundary=(connecta-[\w-]+)$/.exec(contentType)?.[1];
    expect(boundary).toBeDefined();
    // Bytes, never a stream, so a 401 replay can send it again.
    expect(calls[0]!.raw).toBeInstanceOf(Uint8Array);
    const parts = decode(calls[0]!.raw).split(`--${boundary}`);
    expect(parts[1]).toBe(
      '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"notes.md","parents":["folder-1"],"mimeType":"text/markdown"}\r\n',
    );
    expect(parts[2]).toBe("\r\nContent-Type: text/markdown\r\n\r\n# Notes — café\r\n");
    expect(parts[3]).toBe("--\r\n");
    expect(result).toEqual({ id: "f9", name: "notes.md", mimeType: "text/markdown" });
  });

  it("resends the same upload bytes when a 401 forces a fresh token", async () => {
    let first = true;
    route = () => {
      if (!first) return { body: { id: "f9" } };
      first = false;
      return GOOGLE_ERROR(401, "authError", "Invalid Credentials");
    };
    await call(connection(), "create_file", { name: "a.txt", content: "same bytes" });
    expect(calls.map((_, index) => line(index))).toEqual(["POST upload/files", "POST upload/files"]);
    expect(tokenCalls).toBe(2);
    expect(decode(calls[1]!.raw)).toBe(decode(calls[0]!.raw));
    expect(decode(calls[1]!.raw)).toContain("same bytes");
  });

  it("imports content as a Google Doc, and creates an empty Sheet with no upload", async () => {
    route = () => ({ body: { id: "d1" } });
    await call(connection(), "create_file", { name: "Minutes", content: "# Minutes", mimeType: "text/markdown", convertTo: "document" });
    const body = decode(calls[0]!.raw);
    expect(body).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(body).toContain("Content-Type: text/markdown\r\n\r\n# Minutes");

    calls.length = 0;
    await call(connection(), "create_file", { name: "Roster", convertTo: "spreadsheet" });
    expect(line(0)).toBe("POST /files");
    expect(calls[0]!.body).toEqual({ name: "Roster", mimeType: "application/vnd.google-apps.spreadsheet" });
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

  it("replaces content with a media upload", async () => {
    route = () => ({ body: { id: "f1", name: "notes.txt" } });
    await call(connection(), "update_file_content", { fileId: "f1", content: "new text", mimeType: "text/plain" });
    expect(line(0)).toBe("PATCH upload/files/f1");
    expect(query(0)).toMatchObject({ uploadType: "media", supportsAllDrives: "true" });
    expect(calls[0]!.headers.get("content-type")).toBe("text/plain");
    expect(decode(calls[0]!.raw)).toBe("new text");
    await expect(
      call(connection(), "update_file_content", { fileId: "f1", mimeType: "text/plain" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("renames, and refuses an update that changes nothing", async () => {
    route = () => ({ body: { id: "f1", name: "Budget (final)" } });
    await call(connection(), "update_file", { fileId: "f1", name: "Budget (final)" });
    expect(line(0)).toBe("PATCH /files/f1");
    expect(calls[0]!.body).toEqual({ name: "Budget (final)" });
    calls.length = 0;
    await expect(call(connection(), "update_file", { fileId: "f1" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toEqual([]);
  });

  it("moves out of every current folder into the new one", async () => {
    route = (request) =>
      request.method === "GET" ? { body: { parents: ["old-1"] } } : { body: { id: "f1", parents: ["new-1"] } };
    const result = await call(connection(), "move_file", { fileId: "f1", folderId: "new-1" });
    expect(line(0)).toBe("GET /files/f1");
    expect(line(1)).toBe("PATCH /files/f1");
    expect(query(1)).toMatchObject({ addParents: "new-1", removeParents: "old-1" });
    expect(calls[1]!.body).toEqual({});
    expect(result).toEqual({ id: "f1", parents: ["new-1"] });
  });

  it("copies, trashes, and restores", async () => {
    route = () => ({ body: { id: "c1" } });
    await call(connection(), "copy_file", { fileId: "f1", name: "Budget copy", parentId: "folder-2" });
    expect(line(0)).toBe("POST /files/f1/copy");
    expect(calls[0]!.body).toEqual({ name: "Budget copy", parents: ["folder-2"] });

    route = (request) => ({ body: { id: "f1", trashed: request.body.trashed } });
    expect(await call(connection(), "trash_file", { fileId: "f1" })).toEqual({ id: "f1", trashed: true });
    expect(line(1)).toBe("PATCH /files/f1");
    expect(calls[1]!.body).toEqual({ trashed: true });
    expect(await call(connection(), "restore_file", { fileId: "f1" })).toEqual({ id: "f1", trashed: false });
    expect(calls[2]!.body).toEqual({ trashed: false });
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
    ["create_file without content", "create_file", { name: "Doc", convertTo: "document" }, "search_files"],
    ["create_folder", "create_folder", { name: "Elders" }, "search_files"],
    ["copy_file", "copy_file", { fileId: "f1" }, "second copy"],
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

  it("leaves the shared advice alone for writes that are safe to re-read and repeat", async () => {
    route = BROKEN_REPLY;
    const failure = await call(connection(), "update_file", { fileId: "f1", name: "b" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("Re-read");
    expect(failure.message).not.toContain("search_files");
  });

  it("adds nothing to a refusal: Google said no, and nothing was made", async () => {
    route = () => GOOGLE_ERROR(400, "invalid", "Invalid parents field.");
    const failure = await call(connection(), "create_folder", { name: "Elders", parentId: "nope" }).catch((error) => error);
    expect(failure.code).toBe("invalid_args");
    expect(failure.message).not.toContain("search_files");
  });
});

describe("sharing", () => {
  it("shares with a user without emailing them by default", async () => {
    route = () => ({ body: { id: "p1", type: "user", role: "writer", emailAddress: "bo@church.example" } });
    const result = await call(connection(), "share_file", {
      fileId: "f1",
      type: "user",
      role: "writer",
      emailAddress: "bo@church.example",
    });
    expect(line(0)).toBe("POST /files/f1/permissions");
    expect(query(0)).toMatchObject({ sendNotificationEmail: "false", supportsAllDrives: "true" });
    expect(query(0)["transferOwnership"]).toBeUndefined();
    expect(calls[0]!.body).toEqual({ type: "user", role: "writer", emailAddress: "bo@church.example" });
    expect(result).toEqual({ id: "p1", type: "user", role: "writer", emailAddress: "bo@church.example" });
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
    expect(query(0)).toMatchObject({ sendNotificationEmail: "true", emailMessage: "For Tuesday." });
  });

  it("shares with a domain or anyone with the link, never sending the email flag", async () => {
    route = () => ({ body: { id: "p2" } });
    await call(connection(), "share_file", { fileId: "f1", type: "domain", role: "reader", domain: "church.example" });
    expect(query(0)["sendNotificationEmail"]).toBeUndefined();
    expect(calls[0]!.body).toEqual({ type: "domain", role: "reader", domain: "church.example", allowFileDiscovery: false });
    await call(connection(), "share_file", { fileId: "f1", type: "anyone", role: "reader", allowFileDiscovery: true });
    expect(calls[1]!.body).toEqual({ type: "anyone", role: "reader", allowFileDiscovery: true });
  });

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

  it("changes and removes one permission", async () => {
    route = () => ({ body: { id: "p1", role: "reader" } });
    await call(connection(), "update_permission", { fileId: "f1", permissionId: "p1", role: "reader" });
    expect(line(0)).toBe("PATCH /files/f1/permissions/p1");
    expect(calls[0]!.body).toEqual({ role: "reader" });

    route = () => ({ status: 204 });
    const removed = await call(connection(), "delete_permission", { fileId: "f1", permissionId: "anyoneWithLink" });
    expect(line(1)).toBe("DELETE /files/f1/permissions/anyoneWithLink");
    expect(removed).toEqual({ fileId: "f1", permissionId: "anyoneWithLink", deleted: true });
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
      return { body: { drives: [{ id: "sd-1", name: "Finance", hidden: true, colorRgb: "#000" }], nextPageToken: "d" } };
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
  const empty: Route = (request) =>
    request.method === "DELETE" ? { status: 204 } : { body: {} };

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

  it("covers every tool", async () => {
    const names = (await connection().listTools(context())).map((tool) => tool.name).sort();
    expect(CASES.map(([name]) => name).sort()).toEqual(names);
  });

  it.each([
    ["realistic", rich],
    ["empty", empty],
  ] as const)("declares every key of a %s response, and omits nothing required", async (_kind, responses) => {
    const connector = connection();
    const schemas = Object.fromEntries((await connector.listTools(context())).map((tool) => [tool.name, tool.outputSchema]));
    route = responses;
    const found: string[] = [];
    for (const [name, args] of CASES) {
      const result = await call(connector, name, args);
      mismatches(result, schemas[name], name, found);
    }
    expect(found).toEqual([]);
  });

  it("keeps what a realistic response says, inherited shares included", async () => {
    route = rich;
    const permissions = await call(connection(), "list_permissions", { fileId: "f1" });
    expect(permissions.permissions[0]).toMatchObject({ inherited: true, inheritedFrom: "folder-1", deleted: true });
    const file = await call(connection(), "get_file", { fileId: "f1" });
    expect(file).toMatchObject({ shortcutTargetId: "t1", modifiedBy: "ann@church.example", driveId: "sd-1" });
    expect(Object.keys(file.capabilities)).toHaveLength(7);
  });

  it("answers with the id the call named when Google's response omits it", async () => {
    route = empty;
    expect(await call(connection(), "get_file", { fileId: "f1" })).toEqual({ id: "f1" });
    expect(await call(connection(), "trash_file", { fileId: "f1" })).toEqual({ id: "f1" });
    expect(await call(connection(), "update_permission", { fileId: "f1", permissionId: "p1", role: "reader" })).toEqual({
      id: "p1",
    });
  });
});

describe("every default result crosses into execute_code", () => {
  // A host result reaches a QuickJS program only under 256 KiB serialized
  // (MAX_QUICKJS_HOST_RPC_BYTES). Defaults must fit with room to spare on the
  // worst input Drive can send; explicit maxima may exceed it and are
  // documented as direct-call only, where get_result pages them.
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
    route = () => ({ body: { files: Array.from({ length: 25 }, (_, index) => worstFile(index)), nextPageToken: "n".repeat(1024) } });
    for (const [name, args] of [["search_files", {}], ["list_folder_items", { folderId: "root" }]] as const) {
      const result = await call(connection(), name, args);
      expect(result.files).toHaveLength(25);
      expect(result.files[0].nameTruncated).toBe(true);
      expect(serialized(result), name).toBeLessThanOrEqual(BUDGET);
    }
  });

  it("cuts a name to 2 KiB in a listing and 32 KiB in get_file, and flags each cut", async () => {
    const name = "n".repeat(3_000);
    route = (request) => (request.url.pathname.endsWith("/files") ? { body: { files: [{ id: "f1", name }] } } : { body: { id: "f1", name } });
    const listedFile = (await call(connection(), "search_files")).files[0];
    expect(listedFile.nameTruncated).toBe(true);
    expect(listedFile.name.endsWith("…")).toBe(true);
    expect(serialized(listedFile.name)).toBeLessThanOrEqual(2 * 1024);
    expect(await call(connection(), "get_file", { fileId: "f1" })).toEqual({ id: "f1", name });

    const huge = { id: "f1", name: worst(32_767), description: worst(40_000) };
    route = () => ({ body: huge });
    const detail = await call(connection(), "get_file", { fileId: "f1" });
    expect(detail).toMatchObject({ nameTruncated: true, descriptionTruncated: true });
    expect(serialized(detail)).toBeLessThanOrEqual(BUDGET);
    expect(detail.name).toBe(detail.name.toWellFormed());
  });

  it("fits a default page of permissions and of shared drives", async () => {
    route = (request) =>
      request.url.pathname.endsWith("/drives")
        ? { body: { drives: Array.from({ length: 25 }, (_, index) => ({ id: `d${index}`, name: worst(1_000) })) } }
        : {
            body: {
              permissions: Array.from({ length: 25 }, (_, index) => ({
                id: `p${index}`.padEnd(30, "0"),
                type: "user",
                role: "fileOrganizer",
                emailAddress: longEmail,
                domain: "b".repeat(253),
                displayName: worst(1_000),
                expirationTime: "2027-01-01T00:00:00.000Z",
                permissionDetails: [{ inherited: true, inheritedFrom: "f".repeat(44) }],
              })),
            },
          };
    expect(serialized(await call(connection(), "list_permissions", { fileId: "f1" }))).toBeLessThanOrEqual(BUDGET);
    expect(serialized(await call(connection(), "list_shared_drives"))).toBeLessThanOrEqual(BUDGET);
  });

  it("stops a page that would outgrow maxBytes, and resumes at the first row left out", async () => {
    // A hundred rows of 1,000-character escaped names: about 600 KB in all.
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...worstFile(index), id: `r${index}`, name: worst(1_000) }));
    route = (request) =>
      request.url.searchParams.get("pageToken") === "second"
        ? { body: { files: [{ id: "last" }] } }
        : { body: { files: rows, nextPageToken: "second" } };
    for (const maxBytes of [undefined, 16_384, 50_000]) {
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

  it("fits default content, text and binary, at its largest", async () => {
    const meta = (mimeType: string, size: string) => (request: ApiCall) =>
      request.url.searchParams.get("fields") ? { body: { id: "f1", name: worst(500), mimeType, size } } : undefined;
    const textRoute = meta("text/plain", "999999999");
    route = (request) => textRoute(request) ?? { payload: worst(200_000), contentType: "text/plain" };
    const text = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(text.contentTruncated).toBe(true);
    expect(serialized(text)).toBeLessThanOrEqual(BUDGET);

    const binaryRoute = meta("application/pdf", String(140 * 1024));
    route = (request) => binaryRoute(request) ?? { payload: new Uint8Array(140 * 1024).fill(255) };
    const binary = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(binary.format).toBe("base64");
    expect(serialized(binary)).toBeLessThanOrEqual(BUDGET);
  });

  it("holds the whole content result, name and metadata included, to maxBytes", async () => {
    // The longest name and the most text the schema allows, all escaped.
    const meta = (mimeType: string) => (request: ApiCall) =>
      request.url.searchParams.get("fields") ? { body: { id: "f1", name: worst(32_767), mimeType, size: "999999999" } } : undefined;
    for (const mimeType of ["text/plain", "application/vnd.google-apps.document"]) {
      const metaRoute = meta(mimeType);
      route = (request) => metaRoute(request) ?? { payload: worst(250_000), contentType: "text/plain" };
      for (const maxBytes of [undefined, 16_384, 100_000]) {
        const result = await call(connection(), "get_file_content", {
          fileId: "f1",
          maxChars: 100_000,
          ...(maxBytes ? { maxBytes } : {}),
        });
        expect(serialized(result), `${mimeType} ${maxBytes}`).toBeLessThanOrEqual(maxBytes ?? BUDGET);
        expect(result).toMatchObject({ nameTruncated: true, contentTruncated: true });
        expect(result.content).toContain("raise maxBytes");
        expect(result.content).toBe(result.content.toWellFormed());
      }
      // Raised for a direct call, maxChars binds instead.
      const direct = await call(connection(), "get_file_content", { fileId: "f1", maxChars: 100_000, maxBytes: 4 * 1024 * 1024 });
      expect(direct.content).toContain("raise maxChars");
      expect(serialized(direct)).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });
});

describe("a cursor resumes only the listing, and the page, it was issued for", () => {
  // Thirty rows of 1,500-character names: a 16 KiB result holds about nine,
  // so the first call stops mid-page and its cursor resumes by position.
  const ids = Array.from({ length: 30 }, (_, index) => `r${String(index).padStart(2, "0")}`);
  const rowsOf = (order: readonly string[]) => order.map((id) => ({ id, name: `${id}-${"n".repeat(1_500)}` }));
  const SMALL = { maxBytes: 16_384 };

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
    ["given an id before the resume point", (order: string[]) => ["new", ...order]],
    ["missing an id before the resume point", (order: string[]) => order.slice(1)],
    ["given an id after the resume point", (order: string[]) => [...order, "late"]],
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

  it("keeps Drive's own token at a whole-page boundary, with nothing to prove", async () => {
    route = () => ({ body: { files: rowsOf(ids.slice(0, 3)), nextPageToken: "second" } });
    const connector = connection();
    const first = await call(connector, "search_files", { limit: 3 });
    // The next page may differ in any way; a boundary resumes Drive's token.
    route = () => ({ body: { files: rowsOf(["x", "y"]) } });
    const second = await call(connector, "search_files", { limit: 3, cursor: first.page.nextCursor });
    expect(calls[1]!.url.searchParams.get("pageToken")).toBe("second");
    expect(second.files.map((file: any) => file.id)).toEqual(["x", "y"]);
  });

  it("lets maxBytes change between pages, since it only decides where a page stops", async () => {
    const connector = connection();
    const first = await firstPage(connector);
    const rest = await call(connector, "search_files", { maxBytes: 4 * 1024 * 1024, cursor: first.page.nextCursor });
    expect(rest.files[0].id).toBe(ids[first.files.length]);
    expect(first.files.length + rest.files.length).toBe(ids.length);
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
