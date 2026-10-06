// The Google Drive connection. Tests stub the network and pin the requests
// each tool sends, the projections it returns, the uploads it frames, and the
// surface it refuses to have — H1, H9, H10, H11, and H14 for this provider.
// Delegation, subjects, and tokens are test/google-workspace-delegation.test.ts;
// what this suite adds is that Drive's two transports act as the same account.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCaller } from "../src/connector-caller.js";
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
    if (reply.payload !== undefined) {
      return new Response(reply.payload, {
        status: reply.status ?? 200,
        headers: { "Content-Type": reply.contentType ?? "application/octet-stream" },
      });
    }
    if (reply.status === 204) return new Response(null, { status: 204 });
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
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
    for (const name of ["create_folder", "create_file", "copy_file", "restore_file"]) {
      expect(byName[name]!.annotations, name).toEqual({ readOnlyHint: false, destructiveHint: false });
    }
    for (const name of [
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
    const result = await call(connection(), "search_files", {
      query: "name contains 'budget'",
      orderBy: "modifiedTime desc",
      limit: 5,
      cursor: "prev",
    });
    expect(line(0)).toBe("GET /files");
    const sent = query(0);
    expect(sent).toMatchObject({
      q: "(name contains 'budget') and trashed = false",
      corpora: "user",
      orderBy: "modifiedTime desc",
      pageSize: "5",
      pageToken: "prev",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
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
      page: { hasMore: true, nextCursor: "next-1" },
    });
    expect(JSON.stringify(result)).not.toContain("noise");
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
    expect(drives).toEqual({ drives: [{ id: "sd-1", name: "Finance" }], page: { hasMore: true, nextCursor: "d2" } });

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

  it("says what an export refusal likely means rather than blaming access alone", async () => {
    const meta = metadata({ mimeType: "application/vnd.google-apps.document", capabilities: { canDownload: true } });
    route = (request) =>
      meta(request) ?? GOOGLE_ERROR(403, "exportSizeLimitExceeded", "This file is too large to be exported.");
    const failure = await call(connection(), "get_file_content", { fileId: "f1" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("10 MB");
  });

  it("reads a small text file whole, with no range", async () => {
    const meta = metadata({ mimeType: "application/json", size: "17" });
    route = (request) => meta(request) ?? { payload: '{"ok":true,"n":1}', contentType: "application/json" };
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(line(1)).toBe("GET /files/f1");
    expect(query(1)).toMatchObject({ alt: "media" });
    expect(calls[1]!.headers.get("range")).toBeNull();
    expect(result).toMatchObject({ format: "text", content: '{"ok":true,"n":1}', contentTruncated: false, size: 17 });
  });

  it("reads only a range of a large text file and marks the cut", async () => {
    const meta = metadata({ mimeType: "text/plain", size: "5000000" });
    route = (request) => meta(request) ?? { status: 206, payload: "abcdefghij…partial", contentType: "text/plain" };
    const result = await call(connection(), "get_file_content", { fileId: "f1", maxChars: 10 });
    expect(calls[1]!.headers.get("range")).toBe("bytes=0-43");
    expect(result.contentTruncated).toBe(true);
    expect(result.content).toBe(
      "abcdefghij\n[… truncated: 10 characters of a 5000000-byte file shown; raise maxChars (up to 100000) to read more]",
    );
  });

  it("returns a small binary as base64", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const meta = metadata({ mimeType: "application/pdf", size: "6" });
    route = (request) => meta(request) ?? { payload: bytes, contentType: "application/pdf" };
    const result = await call(connection(), "get_file_content", { fileId: "f1" });
    expect(result).toMatchObject({ format: "base64", content: "JVBERgD/", contentTruncated: false });
  });

  it.each([
    ["a binary past the inline cap", { mimeType: "application/pdf", size: String(2 * 1024 * 1024) }, "inline cap"],
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

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}
