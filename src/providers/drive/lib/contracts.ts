// Drive named tool contracts, kept separate from the workflow programs.
import { routeDescription } from "../../../agent-routes.js";
import { Schema } from "effect";
import { Integer, isMinChars, isMaxChars } from "../../../http/json-schema.js";
const matchesPattern = (pattern: RegExp) =>
  Schema.makeFilter((value: string) => pattern.test(value), {
    expected: `a string matching ${pattern.source}`,
    toJsonSchema: () => ({ pattern: pattern.source }),
  });

export const search_files = {
  input: Schema.Struct({
    "query": Schema.optionalKey(
      Schema.String.check(isMaxChars(2048)).annotate({
        "description":
          "Drive query: name contains 'budget', fullText contains 'elders', mimeType = 'application/pdf', modifiedTime > '2026-01-01T00:00:00', 'me' in owners. Omit for everything.",
      }),
    ),
    "corpora": Schema.optionalKey(
      Schema.Literals(["user", "domain", "drive", "allDrives"]).annotate({
        "description":
          "Where to look: user (default; My Drive and shared with me), drive (one shared drive, with driveId), allDrives (slower, may be incomplete), domain.",
      }),
    ),
    "driveId": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(256), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description": "Shared drive id from list_shared_drives; required with corpora drive, refused otherwise.",
      }),
    ),
    "orderBy": Schema.optionalKey(
      Schema.Literals([
        "modifiedTime desc",
        "modifiedTime",
        "name",
        "name desc",
        "createdTime desc",
        "folder,name",
      ]).annotate({
        "description": "Sort order. Drive refuses any sort on a fullText query, which comes back by relevance.",
      }),
    ),
    "includeTrashed": Schema.optionalKey(
      Schema.Boolean.annotate({ "description": "Include trashed files, which are left out by default." }),
    ),
    "limit": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
        "description": "Rows per page, 1 to 100; defaults to 25. Connecta's cap, below Drive's 1,000.",
        "default": 25,
      }),
    ),
    "cursor": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(32768), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description": "Opaque page.nextCursor from the previous page. Pass it back unchanged with the same arguments.",
      }),
    ),
    "maxBytes": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(65536), Schema.isLessThanOrEqualTo(4194304)).annotate({
        "description": routeDescription(
          (routes) =>
            `Serialized bytes of the whole result; defaults to 196608, what ${routes.program} can receive. Raise it, to 4194304, only for a direct ${routes.read} read.`,
        ),
      }),
    ),
  }),
  output: Schema.Struct({
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
    "items": Schema.Array(
      Schema.Struct({
        "id": Schema.optionalKey(Schema.String),
        "name": Schema.optionalKey(Schema.String),
        "mimeType": Schema.optionalKey(Schema.String),
        "parents": Schema.optionalKey(Schema.Array(Schema.String)),
        "driveId": Schema.optionalKey(Schema.String),
        "size": Schema.optionalKey(Integer),
        "modifiedTime": Schema.optionalKey(Schema.String),
        "owners": Schema.optionalKey(Schema.Array(Schema.String)),
        "trashed": Schema.optionalKey(Schema.Boolean),
        "webViewLink": Schema.optionalKey(Schema.String),
        "shortcutTargetId": Schema.optionalKey(Schema.String),
        "shortcutTargetMimeType": Schema.optionalKey(Schema.String),
        "truncated": Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            "description":
              "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
          }),
        ),
      }),
    ),
    "incompleteSearch": Schema.optionalKey(Schema.Boolean),
    "page": Schema.Struct({ "hasMore": Schema.Boolean, "nextCursor": Schema.optionalKey(Schema.String) }),
  }),
};

export const list_folder_items = {
  input: Schema.Struct({
    "folderId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Folder id, a shared drive id for its top level, or root for My Drive." }),
    "orderBy": Schema.optionalKey(
      Schema.Literals([
        "modifiedTime desc",
        "modifiedTime",
        "name",
        "name desc",
        "createdTime desc",
        "folder,name",
      ]).annotate({ "description": "Sort order; defaults to folders first, then by name." }),
    ),
    "includeTrashed": Schema.optionalKey(
      Schema.Boolean.annotate({ "description": "Include trashed files, which are left out by default." }),
    ),
    "limit": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
        "description": "Rows per page, 1 to 100; defaults to 25. Connecta's cap, below Drive's 1,000.",
        "default": 25,
      }),
    ),
    "cursor": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(32768), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description": "Opaque page.nextCursor from the previous page. Pass it back unchanged with the same arguments.",
      }),
    ),
    "maxBytes": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(65536), Schema.isLessThanOrEqualTo(4194304)).annotate({
        "description": routeDescription(
          (routes) =>
            `Serialized bytes of the whole result; defaults to 196608, what ${routes.program} can receive. Raise it, to 4194304, only for a direct ${routes.read} read.`,
        ),
      }),
    ),
  }),
  output: Schema.Struct({
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
    "items": Schema.Array(
      Schema.Struct({
        "id": Schema.optionalKey(Schema.String),
        "name": Schema.optionalKey(Schema.String),
        "mimeType": Schema.optionalKey(Schema.String),
        "parents": Schema.optionalKey(Schema.Array(Schema.String)),
        "driveId": Schema.optionalKey(Schema.String),
        "size": Schema.optionalKey(Integer),
        "modifiedTime": Schema.optionalKey(Schema.String),
        "owners": Schema.optionalKey(Schema.Array(Schema.String)),
        "trashed": Schema.optionalKey(Schema.Boolean),
        "webViewLink": Schema.optionalKey(Schema.String),
        "shortcutTargetId": Schema.optionalKey(Schema.String),
        "shortcutTargetMimeType": Schema.optionalKey(Schema.String),
        "truncated": Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            "description":
              "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
          }),
        ),
      }),
    ),
    "incompleteSearch": Schema.optionalKey(Schema.Boolean),
    "page": Schema.Struct({ "hasMore": Schema.Boolean, "nextCursor": Schema.optionalKey(Schema.String) }),
  }),
};

export const get_file = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "name": Schema.optionalKey(Schema.String),
    "mimeType": Schema.optionalKey(Schema.String),
    "parents": Schema.optionalKey(Schema.Array(Schema.String)),
    "driveId": Schema.optionalKey(Schema.String),
    "size": Schema.optionalKey(Integer),
    "modifiedTime": Schema.optionalKey(Schema.String),
    "owners": Schema.optionalKey(Schema.Array(Schema.String)),
    "trashed": Schema.optionalKey(Schema.Boolean),
    "webViewLink": Schema.optionalKey(Schema.String),
    "shortcutTargetId": Schema.optionalKey(Schema.String),
    "shortcutTargetMimeType": Schema.optionalKey(Schema.String),
    "truncated": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        "description":
          "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
      }),
    ),
    "description": Schema.optionalKey(Schema.String),
    "createdTime": Schema.optionalKey(Schema.String),
    "modifiedBy": Schema.optionalKey(Schema.String),
    "shared": Schema.optionalKey(Schema.Boolean),
    "starred": Schema.optionalKey(Schema.Boolean),
    "capabilities": Schema.optionalKey(
      Schema.Struct({
        "canEdit": Schema.optionalKey(Schema.Boolean),
        "canComment": Schema.optionalKey(Schema.Boolean),
        "canShare": Schema.optionalKey(Schema.Boolean),
        "canDownload": Schema.optionalKey(Schema.Boolean),
        "canTrash": Schema.optionalKey(Schema.Boolean),
        "canRename": Schema.optionalKey(Schema.Boolean),
        "canAddChildren": Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
};

export const get_file_content = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
    "maxChars": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100000)).annotate({
        "description":
          "Characters (code points) of text kept, 1 to 100000; defaults to 20000. Longer text ends with a truncation marker. Binaries ignore it.",
      }),
    ),
    "maxBytes": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(65536), Schema.isLessThanOrEqualTo(4194304)).annotate({
        "description": routeDescription(
          (routes) =>
            `Serialized bytes of the whole result; defaults to 196608, what ${routes.program} can receive. Raise it, to 4194304, only for a direct ${routes.read} read.`,
        ),
      }),
    ),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "name": Schema.optionalKey(Schema.String),
    "mimeType": Schema.optionalKey(Schema.String),
    "size": Schema.optionalKey(Integer),
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
    "webViewLink": Schema.optionalKey(Schema.String),
    "format": Schema.optionalKey(Schema.Literals(["markdown", "csv", "text", "base64", "unavailable"])),
    "exportedAs": Schema.optionalKey(Schema.String),
    "content": Schema.optionalKey(Schema.String),
    "note": Schema.optionalKey(Schema.String),
  }),
};

export const list_permissions = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
    "limit": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
        "description": "Rows per page, 1 to 100; defaults to 25. Connecta's cap, below Drive's 1,000.",
        "default": 25,
      }),
    ),
    "cursor": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(32768), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description": "Opaque page.nextCursor from the previous page. Pass it back unchanged with the same arguments.",
      }),
    ),
    "maxBytes": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(65536), Schema.isLessThanOrEqualTo(4194304)).annotate({
        "description": routeDescription(
          (routes) =>
            `Serialized bytes of the whole result; defaults to 196608, what ${routes.program} can receive. Raise it, to 4194304, only for a direct ${routes.read} read.`,
        ),
      }),
    ),
  }),
  output: Schema.Struct({
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
    "items": Schema.Array(
      Schema.Struct({
        "id": Schema.optionalKey(Schema.String),
        "type": Schema.optionalKey(Schema.Literals(["user", "group", "domain", "anyone"])),
        "role": Schema.optionalKey(Schema.String),
        "emailAddress": Schema.optionalKey(Schema.String),
        "domain": Schema.optionalKey(Schema.String),
        "displayName": Schema.optionalKey(Schema.String),
        "allowFileDiscovery": Schema.optionalKey(Schema.Boolean),
        "expirationTime": Schema.optionalKey(Schema.String),
        "inherited": Schema.optionalKey(Schema.Boolean),
        "inheritedFrom": Schema.optionalKey(Schema.String),
        "deleted": Schema.optionalKey(Schema.Boolean),
        "truncated": Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            "description":
              "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
          }),
        ),
      }),
    ),
    "page": Schema.Struct({ "hasMore": Schema.Boolean, "nextCursor": Schema.optionalKey(Schema.String) }),
  }),
};

export const list_shared_drives = {
  input: Schema.Struct({
    "query": Schema.optionalKey(
      Schema.String.check(isMaxChars(1024)).annotate({
        "description": "Shared drive query, e.g. name contains 'Finance'. Omit for every drive.",
      }),
    ),
    "limit": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
        "description": "Rows per page, 1 to 100; defaults to 25. Connecta's cap, below Drive's 1,000.",
        "default": 25,
      }),
    ),
    "cursor": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(32768), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description": "Opaque page.nextCursor from the previous page. Pass it back unchanged with the same arguments.",
      }),
    ),
    "maxBytes": Schema.optionalKey(
      Integer.check(Schema.isGreaterThanOrEqualTo(65536), Schema.isLessThanOrEqualTo(4194304)).annotate({
        "description": routeDescription(
          (routes) =>
            `Serialized bytes of the whole result; defaults to 196608, what ${routes.program} can receive. Raise it, to 4194304, only for a direct ${routes.read} read.`,
        ),
      }),
    ),
  }),
  output: Schema.Struct({
    "truncated": Schema.optionalKey(Schema.Array(Schema.String)),
    "items": Schema.Array(
      Schema.Struct({
        "id": Schema.optionalKey(Schema.String),
        "name": Schema.optionalKey(Schema.String),
        "hidden": Schema.optionalKey(Schema.Boolean),
        "truncated": Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            "description":
              "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
          }),
        ),
      }),
    ),
    "page": Schema.Struct({ "hasMore": Schema.Boolean, "nextCursor": Schema.optionalKey(Schema.String) }),
  }),
};

export const create_folder = {
  input: Schema.Struct({
    "name": Schema.String.check(isMinChars(1), isMaxChars(1000), matchesPattern(new RegExp("^[^\\r\\n]*$"))).annotate({
      "description": "File name as Drive shows it, extension included where it has one.",
    }),
    "parentId": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(256), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description": "Folder id to place it in, or root for My Drive; defaults to My Drive.",
      }),
    ),
    "description": Schema.optionalKey(
      Schema.String.check(isMaxChars(10000)).annotate({
        "description": "Free-text description shown in Drive's details pane.",
      }),
    ),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "name": Schema.optionalKey(Schema.String),
    "mimeType": Schema.optionalKey(Schema.String),
    "parents": Schema.optionalKey(Schema.Array(Schema.String)),
    "driveId": Schema.optionalKey(Schema.String),
    "size": Schema.optionalKey(Integer),
    "modifiedTime": Schema.optionalKey(Schema.String),
    "owners": Schema.optionalKey(Schema.Array(Schema.String)),
    "trashed": Schema.optionalKey(Schema.Boolean),
    "webViewLink": Schema.optionalKey(Schema.String),
    "shortcutTargetId": Schema.optionalKey(Schema.String),
    "shortcutTargetMimeType": Schema.optionalKey(Schema.String),
    "truncated": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        "description":
          "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
      }),
    ),
  }),
};

export const create_file = {
  input: Schema.Struct({
    "name": Schema.String.check(isMinChars(1), isMaxChars(1000), matchesPattern(new RegExp("^[^\\r\\n]*$"))).annotate({
      "description": "File name as Drive shows it, extension included where it has one.",
    }),
    "parentId": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(256), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description": "Folder id to place it in, or root for My Drive; defaults to My Drive.",
      }),
    ),
    "content": Schema.optionalKey(
      Schema.String.check(isMaxChars(1000000)).annotate({
        "description": "Text content, up to 1000000 characters (connecta's cap). Exclusive with contentBase64.",
      }),
    ),
    "contentBase64": Schema.optionalKey(
      Schema.String.check(isMaxChars(1398104), matchesPattern(new RegExp("^[A-Za-z0-9+/]*={0,2}$"))).annotate({
        "description":
          "Binary content as base64, up to 1048576 bytes decoded (connecta's cap; Drive allows 5 MB). Exclusive with content.",
      }),
    ),
    "mimeType": Schema.optionalKey(
      Schema.String.check(
        isMaxChars(255),
        matchesPattern(new RegExp("^[A-Za-z0-9][\\w.+-]*/[A-Za-z0-9][\\w.+-]*$")),
      ).annotate({
        "description":
          "Media type of the content: text/plain, text/markdown, text/csv, application/pdf. Never a Google type. Defaults to text/plain or application/octet-stream.",
      }),
    ),
    "convertTo": Schema.optionalKey(
      Schema.Literals(["document", "spreadsheet", "presentation"]).annotate({
        "description":
          "Import as a Google type: markdown, HTML, or text to document; CSV to spreadsheet. Without content, an empty one.",
      }),
    ),
    "description": Schema.optionalKey(
      Schema.String.check(isMaxChars(10000)).annotate({
        "description": "Free-text description shown in Drive's details pane.",
      }),
    ),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "name": Schema.optionalKey(Schema.String),
    "mimeType": Schema.optionalKey(Schema.String),
    "parents": Schema.optionalKey(Schema.Array(Schema.String)),
    "driveId": Schema.optionalKey(Schema.String),
    "size": Schema.optionalKey(Integer),
    "modifiedTime": Schema.optionalKey(Schema.String),
    "owners": Schema.optionalKey(Schema.Array(Schema.String)),
    "trashed": Schema.optionalKey(Schema.Boolean),
    "webViewLink": Schema.optionalKey(Schema.String),
    "shortcutTargetId": Schema.optionalKey(Schema.String),
    "shortcutTargetMimeType": Schema.optionalKey(Schema.String),
    "truncated": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        "description":
          "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
      }),
    ),
  }),
};

export const update_file_content = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
    "content": Schema.optionalKey(
      Schema.String.check(isMaxChars(1000000)).annotate({
        "description": "Text content, up to 1000000 characters (connecta's cap). Exclusive with contentBase64.",
      }),
    ),
    "contentBase64": Schema.optionalKey(
      Schema.String.check(isMaxChars(1398104), matchesPattern(new RegExp("^[A-Za-z0-9+/]*={0,2}$"))).annotate({
        "description":
          "Binary content as base64, up to 1048576 bytes decoded (connecta's cap; Drive allows 5 MB). Exclusive with content.",
      }),
    ),
    "mimeType": Schema.String.check(
      isMaxChars(255),
      matchesPattern(new RegExp("^[A-Za-z0-9][\\w.+-]*/[A-Za-z0-9][\\w.+-]*$")),
    ).annotate({
      "description":
        "Media type of the new content: usually the file's own, text/markdown for a Google Doc, text/csv for a Sheet (replacing every tab).",
    }),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "name": Schema.optionalKey(Schema.String),
    "mimeType": Schema.optionalKey(Schema.String),
    "parents": Schema.optionalKey(Schema.Array(Schema.String)),
    "driveId": Schema.optionalKey(Schema.String),
    "size": Schema.optionalKey(Integer),
    "modifiedTime": Schema.optionalKey(Schema.String),
    "owners": Schema.optionalKey(Schema.Array(Schema.String)),
    "trashed": Schema.optionalKey(Schema.Boolean),
    "webViewLink": Schema.optionalKey(Schema.String),
    "shortcutTargetId": Schema.optionalKey(Schema.String),
    "shortcutTargetMimeType": Schema.optionalKey(Schema.String),
    "truncated": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        "description":
          "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
      }),
    ),
  }),
};

export const update_file = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
    "name": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(1000), matchesPattern(new RegExp("^[^\\r\\n]*$"))).annotate({
        "description": "File name as Drive shows it, extension included where it has one.",
      }),
    ),
    "description": Schema.optionalKey(
      Schema.String.check(isMaxChars(10000)).annotate({
        "description": "Free-text description shown in Drive's details pane.",
      }),
    ),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "name": Schema.optionalKey(Schema.String),
    "mimeType": Schema.optionalKey(Schema.String),
    "parents": Schema.optionalKey(Schema.Array(Schema.String)),
    "driveId": Schema.optionalKey(Schema.String),
    "size": Schema.optionalKey(Integer),
    "modifiedTime": Schema.optionalKey(Schema.String),
    "owners": Schema.optionalKey(Schema.Array(Schema.String)),
    "trashed": Schema.optionalKey(Schema.Boolean),
    "webViewLink": Schema.optionalKey(Schema.String),
    "shortcutTargetId": Schema.optionalKey(Schema.String),
    "shortcutTargetMimeType": Schema.optionalKey(Schema.String),
    "truncated": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        "description":
          "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
      }),
    ),
  }),
};

export const move_file = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
    "folderId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Destination folder id, a shared drive id for its top level, or root for My Drive." }),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "name": Schema.optionalKey(Schema.String),
    "mimeType": Schema.optionalKey(Schema.String),
    "parents": Schema.optionalKey(Schema.Array(Schema.String)),
    "driveId": Schema.optionalKey(Schema.String),
    "size": Schema.optionalKey(Integer),
    "modifiedTime": Schema.optionalKey(Schema.String),
    "owners": Schema.optionalKey(Schema.Array(Schema.String)),
    "trashed": Schema.optionalKey(Schema.Boolean),
    "webViewLink": Schema.optionalKey(Schema.String),
    "shortcutTargetId": Schema.optionalKey(Schema.String),
    "shortcutTargetMimeType": Schema.optionalKey(Schema.String),
    "truncated": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        "description":
          "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
      }),
    ),
  }),
};

export const copy_file = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
    "name": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(1000), matchesPattern(new RegExp("^[^\\r\\n]*$"))).annotate({
        "description": 'Name of the copy; defaults to Drive\'s "Copy of \u2026".',
      }),
    ),
    "parentId": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(256), matchesPattern(new RegExp("^[A-Za-z0-9_-]+$"))).annotate({
        "description": "Folder for the copy; defaults to the original's.",
      }),
    ),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "name": Schema.optionalKey(Schema.String),
    "mimeType": Schema.optionalKey(Schema.String),
    "parents": Schema.optionalKey(Schema.Array(Schema.String)),
    "driveId": Schema.optionalKey(Schema.String),
    "size": Schema.optionalKey(Integer),
    "modifiedTime": Schema.optionalKey(Schema.String),
    "owners": Schema.optionalKey(Schema.Array(Schema.String)),
    "trashed": Schema.optionalKey(Schema.Boolean),
    "webViewLink": Schema.optionalKey(Schema.String),
    "shortcutTargetId": Schema.optionalKey(Schema.String),
    "shortcutTargetMimeType": Schema.optionalKey(Schema.String),
    "truncated": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        "description":
          "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
      }),
    ),
  }),
};

export const trash_file = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "name": Schema.optionalKey(Schema.String),
    "mimeType": Schema.optionalKey(Schema.String),
    "parents": Schema.optionalKey(Schema.Array(Schema.String)),
    "driveId": Schema.optionalKey(Schema.String),
    "size": Schema.optionalKey(Integer),
    "modifiedTime": Schema.optionalKey(Schema.String),
    "owners": Schema.optionalKey(Schema.Array(Schema.String)),
    "trashed": Schema.optionalKey(Schema.Boolean),
    "webViewLink": Schema.optionalKey(Schema.String),
    "shortcutTargetId": Schema.optionalKey(Schema.String),
    "shortcutTargetMimeType": Schema.optionalKey(Schema.String),
    "truncated": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        "description":
          "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
      }),
    ),
  }),
};

export const restore_file = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "name": Schema.optionalKey(Schema.String),
    "mimeType": Schema.optionalKey(Schema.String),
    "parents": Schema.optionalKey(Schema.Array(Schema.String)),
    "driveId": Schema.optionalKey(Schema.String),
    "size": Schema.optionalKey(Integer),
    "modifiedTime": Schema.optionalKey(Schema.String),
    "owners": Schema.optionalKey(Schema.Array(Schema.String)),
    "trashed": Schema.optionalKey(Schema.Boolean),
    "webViewLink": Schema.optionalKey(Schema.String),
    "shortcutTargetId": Schema.optionalKey(Schema.String),
    "shortcutTargetMimeType": Schema.optionalKey(Schema.String),
    "truncated": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        "description":
          "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
      }),
    ),
  }),
};

export const share_file = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
    "type": Schema.Literals(["user", "group", "domain", "anyone"]).annotate({
      "description":
        "Grantee kind: user or group needs emailAddress, domain needs domain, anyone means anyone with the link.",
    }),
    "role": Schema.Literals(["reader", "commenter", "writer", "fileOrganizer", "organizer"]).annotate({
      "description":
        "Access granted. fileOrganizer and organizer exist only on shared drives. Ownership is never granted here.",
    }),
    "emailAddress": Schema.optionalKey(
      Schema.String.check(isMinChars(3), isMaxChars(320), matchesPattern(new RegExp("^[^\\s@]+@[^\\s@]+$"))).annotate({
        "description": "The user's or group's email address, for type user or group only.",
      }),
    ),
    "domain": Schema.optionalKey(
      Schema.String.check(isMinChars(1), isMaxChars(253), matchesPattern(new RegExp("^[A-Za-z0-9.-]+$"))).annotate({
        "description": "The Workspace domain, for type domain only.",
      }),
    ),
    "allowFileDiscovery": Schema.optionalKey(
      Schema.Boolean.annotate({
        "description":
          "For domain or anyone: whether it appears in search rather than needing the link. Defaults to false.",
      }),
    ),
    "sendNotificationEmail": Schema.optionalKey(
      Schema.Boolean.annotate({
        "description":
          "Email a user or group that it was shared. Defaults to false; Drive requires it for a non-Google address.",
      }),
    ),
    "emailMessage": Schema.optionalKey(
      Schema.String.check(isMaxChars(2000)).annotate({
        "description": "Message in the notification email; only with sendNotificationEmail true.",
      }),
    ),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "type": Schema.optionalKey(Schema.Literals(["user", "group", "domain", "anyone"])),
    "role": Schema.optionalKey(Schema.String),
    "emailAddress": Schema.optionalKey(Schema.String),
    "domain": Schema.optionalKey(Schema.String),
    "displayName": Schema.optionalKey(Schema.String),
    "allowFileDiscovery": Schema.optionalKey(Schema.Boolean),
    "expirationTime": Schema.optionalKey(Schema.String),
    "inherited": Schema.optionalKey(Schema.Boolean),
    "inheritedFrom": Schema.optionalKey(Schema.String),
    "deleted": Schema.optionalKey(Schema.Boolean),
    "truncated": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        "description":
          "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
      }),
    ),
  }),
};

export const update_permission = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
    "permissionId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Permission id from list_permissions." }),
    "role": Schema.Literals(["reader", "commenter", "writer", "fileOrganizer", "organizer"]).annotate({
      "description":
        "Access granted. fileOrganizer and organizer exist only on shared drives. Ownership is never granted here.",
    }),
  }),
  output: Schema.Struct({
    "id": Schema.optionalKey(Schema.String),
    "type": Schema.optionalKey(Schema.Literals(["user", "group", "domain", "anyone"])),
    "role": Schema.optionalKey(Schema.String),
    "emailAddress": Schema.optionalKey(Schema.String),
    "domain": Schema.optionalKey(Schema.String),
    "displayName": Schema.optionalKey(Schema.String),
    "allowFileDiscovery": Schema.optionalKey(Schema.Boolean),
    "expirationTime": Schema.optionalKey(Schema.String),
    "inherited": Schema.optionalKey(Schema.Boolean),
    "inheritedFrom": Schema.optionalKey(Schema.String),
    "deleted": Schema.optionalKey(Schema.Boolean),
    "truncated": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        "description":
          "Fields this result shortened (a string ending in \u2026), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
      }),
    ),
  }),
};

export const delete_permission = {
  input: Schema.Struct({
    "fileId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>." }),
    "permissionId": Schema.String.check(
      isMinChars(1),
      isMaxChars(256),
      matchesPattern(new RegExp("^[A-Za-z0-9_-]+$")),
    ).annotate({ "description": "Permission id from list_permissions." }),
  }),
  output: Schema.Struct({ "fileId": Schema.String, "permissionId": Schema.String, "deleted": Schema.Literal(true) }),
};
