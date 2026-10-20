import { drive } from "../../../src/providers/drive/index.js";
import { defineGoldenSpec, type SeenRequest, type StubResponse } from "../harness.js";

// A throwaway RSA key for the service account's JWT assertion. The assertion
// only travels in the token exchange, an auxiliary route recorded by method
// and URL, so a fresh key per process never reaches a golden.
const keys = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN = "golden-google-access-token-drive";

// Delegated tokens are cached per service account for the process. A fresh
// account per scenario makes every scenario mint its own token, so no golden
// depends on which scenario ran first.
let accounts = 0;

const FILE = {
  id: "f1",
  name: "Budget 2027.xlsx",
  mimeType: "application/vnd.ms-excel",
  parents: ["folder-1"],
  size: "12345",
  modifiedTime: "2026-09-30T12:00:00.000Z",
  webViewLink: "https://drive.google.com/file/d/f1/view",
  trashed: false,
  owners: [{ emailAddress: "alice@example.com", displayName: "Alice", photoLink: "https://example.com/alice.png" }],
  kind: "drive#file",
  iconLink: "https://example.com/icon.png",
};

const FOLDER = "application/vnd.google-apps.folder";

/** Route on `METHOD /path` below the Drive root or the upload root. */
const byPath =
  (routes: Record<string, StubResponse>) =>
  (request: SeenRequest): StubResponse | undefined =>
    routes[`${request.method} ${request.url.pathname.replace(/^(\/upload)?\/drive\/v3/, "$1")}`];

const REASONS: Record<number, [status: string, reason: string]> = {
  400: ["INVALID_ARGUMENT", "badRequest"],
  401: ["UNAUTHENTICATED", "authError"],
  403: ["PERMISSION_DENIED", "forbidden"],
  404: ["NOT_FOUND", "notFound"],
  409: ["ALREADY_EXISTS", "conflict"],
  422: ["INVALID_ARGUMENT", "invalid"],
  429: ["RESOURCE_EXHAUSTED", "rateLimitExceeded"],
  500: ["INTERNAL", "backendError"],
};

export default defineGoldenSpec({
  provider: "drive",
  create: () => {
    accounts += 1;
    return drive("files", {
      purpose: "Staff documents for alice",
      serviceAccount: {
        clientEmail: `drive-golden-${accounts}@project.iam.gserviceaccount.com`,
        privateKey: PRIVATE_KEY,
      },
      subject: "alice@example.com",
    } as Parameters<typeof drive>[1]);
  },
  secrets: { privateKey: PRIVATE_KEY, accessToken: ACCESS_TOKEN },
  auxiliary: [
    {
      name: "token",
      match: (request) => request.url.href === TOKEN_URL,
      reply: { body: { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" } },
    },
  ],
  failureReply: (status) => {
    const [canonical, reason] = REASONS[status] ?? ["UNKNOWN", "unknown"];
    const message = `Golden ${status} failure`;
    return {
      status,
      body: { error: { code: status, message, errors: [{ message, domain: "global", reason }], status: canonical } },
    };
  },
  calls: [
    {
      tool: "search_files",
      args: { query: "name contains 'budget'", orderBy: "modifiedTime desc", limit: 5 },
      replies: [{ body: { files: [FILE], nextPageToken: "next-1", incompleteSearch: true, kind: "drive#fileList" } }],
    },
    {
      tool: "list_folder_items",
      args: { folderId: "folder-1" },
      replies: byPath({
        "GET /files/folder-1": { body: { id: "folder-1", mimeType: FOLDER, driveId: "sd-1" } },
        "GET /files": {
          body: {
            files: [
              { id: "folder-2", name: "Archive", mimeType: FOLDER, parents: ["folder-1"], driveId: "sd-1" },
              { id: "f2", name: "Minutes", mimeType: "application/vnd.google-apps.document", parents: ["folder-1"] },
            ],
          },
        },
      }),
    },
    {
      label: "list_folder_items root",
      tool: "list_folder_items",
      args: { folderId: "root", limit: 10 },
      replies: [{ body: { files: [FILE] } }],
    },
    {
      tool: "get_file",
      args: { fileId: "f1" },
      replies: [
        {
          body: {
            ...FILE,
            description: "Draft budget",
            createdTime: "2026-01-01T00:00:00.000Z",
            lastModifyingUser: { emailAddress: "bob@example.com", displayName: "Bob" },
            shared: true,
            starred: false,
            capabilities: { canEdit: true, canShare: false, canDownload: true, canChangeSecurityUpdateEnabled: false },
          },
        },
      ],
    },
    {
      tool: "get_file_content",
      args: { fileId: "d1" },
      replies: byPath({
        "GET /files/d1": {
          body: {
            id: "d1",
            name: "Elders agenda",
            mimeType: "application/vnd.google-apps.document",
            webViewLink: "https://docs.google.com/document/d/d1/edit",
            capabilities: { canDownload: true },
          },
        },
        "GET /files/d1/export": {
          text: "# Elders\n\nAgenda.",
          headers: { "content-type": "text/markdown; charset=utf-8" },
        },
      }),
    },
    {
      label: "get_file_content text",
      tool: "get_file_content",
      args: { fileId: "f3", maxChars: 100 },
      replies: (request) =>
        request.url.searchParams.get("alt") === "media"
          ? { text: '{"ok":true,"n":1}', headers: { "content-type": "application/json" } }
          : { body: { id: "f3", name: "settings.json", mimeType: "application/json", size: "17" } },
    },
    {
      label: "get_file_content binary",
      tool: "get_file_content",
      args: { fileId: "f4" },
      replies: (request) =>
        request.url.searchParams.get("alt") === "media"
          ? { text: "%PDF-1.7", headers: { "content-type": "application/pdf" } }
          : { body: { id: "f4", name: "report.pdf", mimeType: "application/pdf", size: "8" } },
    },
    {
      tool: "list_permissions",
      args: { fileId: "f1", limit: 50 },
      replies: [
        {
          body: {
            permissions: [
              {
                id: "p1",
                type: "user",
                role: "writer",
                emailAddress: "bob@example.com",
                displayName: "Bob",
                photoLink: "https://example.com/bob.png",
              },
              { id: "anyoneWithLink", type: "anyone", role: "reader", allowFileDiscovery: false },
              {
                id: "p3",
                type: "group",
                role: "organizer",
                emailAddress: "staff@example.com",
                permissionDetails: [{ inherited: true, inheritedFrom: "folder-1" }],
              },
            ],
          },
        },
      ],
    },
    {
      tool: "list_shared_drives",
      args: { query: "name contains 'Fin'" },
      replies: [
        {
          body: { drives: [{ id: "sd-1", name: "Finance", hidden: false, kind: "drive#drive" }], nextPageToken: "d2" },
        },
      ],
    },
    {
      tool: "create_folder",
      args: { name: "Elders", parentId: "folder-1" },
      replies: [{ body: { id: "folder-3", name: "Elders", mimeType: FOLDER, parents: ["folder-1"] } }],
    },
    {
      tool: "create_file",
      args: { name: "notes.md", parentId: "folder-1", content: "# Notes — café", mimeType: "text/markdown" },
      replies: [{ body: { id: "f9", name: "notes.md", mimeType: "text/markdown", parents: ["folder-1"], size: "16" } }],
    },
    {
      label: "create_file empty spreadsheet",
      tool: "create_file",
      args: { name: "Roster", convertTo: "spreadsheet" },
      replies: [{ body: { id: "s1", name: "Roster", mimeType: "application/vnd.google-apps.spreadsheet" } }],
    },
    {
      tool: "update_file_content",
      args: { fileId: "f5", content: "new text", mimeType: "text/plain" },
      replies: [{ body: { id: "f5", name: "notes.txt", mimeType: "text/plain", size: "8" } }],
    },
    {
      tool: "update_file",
      args: { fileId: "f1", name: "Budget (final)", description: "Approved budget" },
      replies: [{ body: { ...FILE, name: "Budget (final)" } }],
    },
    {
      tool: "move_file",
      args: { fileId: "f1", folderId: "new-1" },
      replies: byPath({
        "GET /files/f1": { body: { parents: ["old-1"] } },
        "PATCH /files/f1": { body: { ...FILE, parents: ["new-1"] } },
      }),
    },
    {
      tool: "copy_file",
      args: { fileId: "f1", name: "Budget copy", parentId: "folder-2" },
      replies: [{ body: { ...FILE, id: "c1", name: "Budget copy", parents: ["folder-2"] } }],
    },
    { tool: "trash_file", args: { fileId: "f1" }, replies: [{ body: { ...FILE, trashed: true } }] },
    { tool: "restore_file", args: { fileId: "f1" }, replies: [{ body: { ...FILE, trashed: false } }] },
    {
      tool: "share_file",
      args: { fileId: "f1", type: "user", role: "writer", emailAddress: "bob@example.com" },
      replies: [
        { body: { id: "p1", type: "user", role: "writer", emailAddress: "bob@example.com", displayName: "Bob" } },
      ],
    },
    {
      label: "share_file domain",
      tool: "share_file",
      args: { fileId: "f1", type: "domain", role: "reader", domain: "example.com" },
      replies: [
        { body: { id: "p2", type: "domain", role: "reader", domain: "example.com", allowFileDiscovery: false } },
      ],
    },
    {
      tool: "update_permission",
      args: { fileId: "f1", permissionId: "p1", role: "reader" },
      replies: [{ body: { id: "p1", type: "user", role: "reader", emailAddress: "bob@example.com" } }],
    },
    {
      tool: "delete_permission",
      args: { fileId: "f1", permissionId: "anyoneWithLink" },
      replies: [{ status: 204 }],
    },
  ],
  failures: {
    read: { tool: "get_file", args: { fileId: "f1" } },
    write: { tool: "create_folder", args: { name: "Elders", parentId: "folder-1" } },
  },
});
