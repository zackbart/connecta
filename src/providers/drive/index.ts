import { skill } from "./skill.generated.js";
/**
 * Google Drive, as the signed-in Workspace user: search, read, create,
 * upload, rename, move, copy, trash and restore files, and read and change who
 * they are shared with — and nothing that deletes a file for good or hands one
 * to a new owner. Hand-written against the Drive API v3 reference
 * (https://developers.google.com/workspace/drive/api/reference/rest/v3).
 *
 * Whose Drive. Access is a service account with domain-wide delegation
 * (`src/providers/_shared/google/workspace.ts`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. Drive has no `users/me` segment to confine beneath; the token's
 * subject is what every request acts as, so a file id reaches exactly what
 * that person could open in the Drive web app, shared drives included, and no
 * argument names anyone else.
 *
 * Two transports, one account. Uploads go to Drive's upload host
 * (`/upload/drive/v3`), outside the API root, so the provider builds a second
 * confined client for it rather than widening the first to all of
 * `www.googleapis.com`. Each tool uses one of the two, never both, so a
 * `subject` function still runs once per call.
 *
 * What it will not do. There is no permanent delete, no empty-trash, and no
 * ownership transfer: trash is recoverable for thirty days, and an owner change
 * is not. Every write that overwrites content, renames, moves, trashes, or
 * changes sharing is destructive and crosses the host's approval prompt.
 *
 * Drift. `src/providers/drive/drift.json` records the eleven methods the
 * tools call, and `npm run providers:check -- --provider drive` reports a
 * touched contract that moved or a method that stopped accepting the scope
 * below.
 */
import { apiConnector as api, defined, type ApiHandlerContext, type ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import type { Connector, ConnectorContext, JsonSchema } from "../../types.js";
import { RESULT_BUDGET_BYTES, clampText, jsonBytes } from "../_shared/google/result-size.js";
import {
  googleOutcomeOf,
  GOOGLE_WORKSPACE_OPTIONS,
  googleWorkspaceClient,
  workspaceConnection,
  type GoogleWorkspaceClient,
  type GoogleWorkspaceOptions,
} from "../_shared/google/workspace.js";
import { asProviderFactory } from "../../provider.js";

export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";

/**
 * Drive's API root. Uploads use the same path beneath `/upload` on the same
 * origin, which the provider derives from this (or from a `baseUrl` override).
 */
export const DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3";

/**
 * Exactly the scope this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list. Full `drive`, because
 * `drive.file` reaches only files the app itself created and every narrower
 * scope is read-only.
 */
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"] as const;

/** Options for {@link drive}: the shared Workspace delegation options. */
export type DriveOptions = GoogleWorkspaceOptions;

/** Rows are one cheap request per page; Drive's own maximum is 1,000. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_CONTENT_CHARS = 20_000;
const MAX_CONTENT_CHARS = 100_000;
/** A binary file is returned as base64 at or under this size, never above. */
const BINARY_INLINE_BYTES = 1024 * 1024;
/**
 * Serialized bytes of a whole read result — rows or content, envelope and
 * cursor included. Every read is built to stay under `maxBytes`, measured as
 * the UTF-8 length of its JSON, the way both delivery routes measure it. The
 * default is the shared Workspace budget, three quarters of the 256 KiB a
 * host result may carry into execute_code, so a program always receives a
 * default result. A direct call_tool caller may ask for up to 4 MiB, which the
 * result stash (8 MiB by default) still pages through get_result; execute_code
 * cannot receive that much.
 */
const DEFAULT_RESULT_BYTES = RESULT_BUDGET_BYTES;
/**
 * Room for the costliest row — every bounded string at its bound and both
 * capped lists full — beside the longest cursor this connection issues.
 */
const MIN_RESULT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
/**
 * Strings Drive does not bound for us, cut in JSON bytes so one row or one
 * file always fits under the smallest `maxBytes`: a name in a listing, a
 * write result, or a content result; a name and description in get_file; and
 * labels such as a display name. A cut string ends with "…" and its field is
 * named in the result's `truncatedFields`, so a real ellipsis is never taken
 * for a cut. Identifiers are never cut: one that is not a well-formed Drive id
 * is left out and named there instead.
 */
const ROW_NAME_BYTES = 2 * 1024;
const DETAIL_NAME_BYTES = 32 * 1024;
const DETAIL_DESCRIPTION_BYTES = 64 * 1024;
const LABEL_BYTES = 1024;
/** Owners and parents listed per file; Drive returns one of each today. */
const MAX_LISTED_IDS = 10;
/** What a Drive id looks like; anything else is malformed, never echoed. */
const DRIVE_ID = /^[A-Za-z0-9_-]{1,256}$/;
/**
 * The longest cursor this connection issues, and the input schema accepts.
 * Drive's page tokens are a few hundred characters; one so long that a cursor
 * carrying it would pass this is refused when Drive sends it, rather than
 * issued and then refused on replay.
 */
const MAX_CURSOR_CHARS = 16_384;
/** Upload ceiling for text, in characters; Drive's multipart limit is 5 MB. */
const MAX_UPLOAD_CHARS = 1_000_000;
/** Base64 characters for {@link BINARY_INLINE_BYTES} decoded bytes. */
const MAX_UPLOAD_BASE64 = 4 * Math.ceil(BINARY_INLINE_BYTES / 3);
/** Drive's export limit is 10 MB, so an export never nears this. */
const DRIVE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const NATIVE = "application/vnd.google-apps.";

/** Google file types the content tool exports, and as what. */
const EXPORTS: Readonly<Record<string, { mimeType: string; format: ContentFormat; note?: string }>> = {
  "application/vnd.google-apps.document": { mimeType: "text/markdown", format: "markdown" },
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "text/csv",
    format: "csv",
    note: "CSV of the first sheet only; Drive exports no other tab as CSV.",
  },
  "application/vnd.google-apps.presentation": { mimeType: "text/plain", format: "text" },
};

/** `convertTo` values, as the Google type a created file becomes. */
const CONVERSIONS: Readonly<Record<string, string>> = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
};

const SUMMARY_FIELDS =
  "id,name,mimeType,parents,driveId,size,modifiedTime,webViewLink,trashed,owners(emailAddress),shortcutDetails(targetId,targetMimeType)";
const DETAIL_FIELDS = `${SUMMARY_FIELDS},description,createdTime,lastModifyingUser(emailAddress,displayName),shared,starred,capabilities(canEdit,canComment,canShare,canDownload,canTrash,canRename,canAddChildren)`;
const PERMISSION_FIELDS =
  "id,type,role,emailAddress,domain,displayName,allowFileDiscovery,expirationTime,deleted,permissionDetails(inherited,inheritedFrom)";

/** Every file request reaches shared drives as well as My Drive. */
const ALL_DRIVES = { supportsAllDrives: true } as const;

type JsonRecord = Record<string, any>;
type ContentFormat = "markdown" | "csv" | "text" | "base64" | "unavailable";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Drive reports sizes as int64 strings. */
function sizeOf(value: unknown): number | undefined {
  const size = typeof value === "string" ? Number(value) : value;
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

/** Well-formed Drive ids in a list, for a decision rather than a result. */
function idsOf(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === "string" && DRIVE_ID.test(entry));
}

/**
 * What one projection kept, and the name of every field it shortened or left
 * out — reported as `truncatedFields`, never silently.
 */
class Cuts {
  private readonly cut = new Set<string>();

  /** A string Drive does not bound, cut to `bytes` of JSON with "…". */
  label(field: string, value: unknown, bytes = LABEL_BYTES): string | undefined {
    const whole = typeof value === "string" ? value : undefined;
    if (whole === undefined || (whole === "" && field !== "name")) return undefined;
    const kept = clampText(whole, bytes, () => "…");
    if (kept !== whole) this.cut.add(field);
    return kept;
  }

  /** An identifier whole, or left out and named when it is malformed. */
  id(field: string, value: unknown): string | undefined {
    const whole = text(value);
    if (whole === undefined) return undefined;
    if (DRIVE_ID.test(whole)) return whole;
    this.cut.add(field);
    return undefined;
  }

  /** Up to ten well-formed ids; the rest, and any malformed one, are named. */
  ids(field: string, value: unknown): string[] | undefined {
    const all = asArray(value).filter((entry) => typeof entry === "string");
    const kept = idsOf(all);
    if (kept.length !== all.length || kept.length > MAX_LISTED_IDS) this.cut.add(field);
    return kept.length > 0 ? kept.slice(0, MAX_LISTED_IDS) : undefined;
  }

  /** Up to ten labels, each cut as {@link label} cuts one. */
  labels(field: string, values: unknown[]): string[] | undefined {
    const present = values.filter((value): value is string => typeof value === "string" && value !== "");
    if (present.length > MAX_LISTED_IDS) this.cut.add(field);
    const kept = present.slice(0, MAX_LISTED_IDS).map((value) => this.label(field, value)!);
    return kept.length > 0 ? kept : undefined;
  }

  get fields(): string[] | undefined {
    return this.cut.size > 0 ? [...this.cut] : undefined;
  }
}

// --- Projections ------------------------------------------------------------------

/**
 * A file as an agent reads it. `fallbackId` is the id the call already named,
 * for a response that omits it; `nameBytes` bounds the name. Fields cut or
 * left out are named in `truncatedFields`, which `extra` may add to.
 */
function projectFile(
  value: unknown,
  fallbackId?: string,
  nameBytes = ROW_NAME_BYTES,
  extra?: (file: JsonRecord, cuts: Cuts) => JsonRecord,
): JsonRecord {
  const file = asRecord(value);
  const shortcut = asRecord(file["shortcutDetails"]);
  const cuts = new Cuts();
  const projected = compact({
    id: cuts.id("id", file["id"]) ?? fallbackId,
    name: cuts.label("name", file["name"], nameBytes),
    mimeType: cuts.label("mimeType", file["mimeType"]),
    parents: cuts.ids("parents", file["parents"]),
    driveId: cuts.id("driveId", file["driveId"]),
    size: sizeOf(file["size"]),
    modifiedTime: cuts.label("modifiedTime", file["modifiedTime"]),
    owners: cuts.labels("owners", asArray(file["owners"]).map((owner) => asRecord(owner)["emailAddress"])),
    trashed: bool(file["trashed"]),
    webViewLink: cuts.label("webViewLink", file["webViewLink"]),
    shortcutTargetId: cuts.id("shortcutTargetId", shortcut["targetId"]),
    shortcutTargetMimeType: cuts.label("shortcutTargetMimeType", shortcut["targetMimeType"]),
    ...extra?.(file, cuts),
  });
  return compact({ ...projected, truncatedFields: cuts.fields });
}

const CAPABILITIES = [
  "canEdit",
  "canComment",
  "canShare",
  "canDownload",
  "canTrash",
  "canRename",
  "canAddChildren",
] as const;

function projectFileDetail(value: unknown, fallbackId: string): JsonRecord {
  return projectFile(value, fallbackId, DETAIL_NAME_BYTES, (file, cuts) => {
    const modifier = asRecord(file["lastModifyingUser"]);
    const granted = asRecord(file["capabilities"]);
    const capabilities = compact(
      Object.fromEntries(CAPABILITIES.map((name) => [name, bool(granted[name])])),
    );
    return {
      description: cuts.label("description", file["description"], DETAIL_DESCRIPTION_BYTES),
      createdTime: cuts.label("createdTime", file["createdTime"]),
      modifiedBy:
        cuts.label("modifiedBy", text(modifier["emailAddress"])) ?? cuts.label("modifiedBy", text(modifier["displayName"])),
      shared: bool(file["shared"]),
      starred: bool(file["starred"]),
      capabilities: Object.keys(capabilities).length > 0 ? capabilities : undefined,
    };
  });
}

function projectPermission(value: unknown, fallbackId?: string): JsonRecord {
  const permission = asRecord(value);
  const details = asArray(permission["permissionDetails"]).map(asRecord);
  const cuts = new Cuts();
  const inheritedFrom = details
    .map((detail) => cuts.id("inheritedFrom", detail["inheritedFrom"]))
    .find((id) => id !== undefined);
  return compact({
    id: cuts.id("id", permission["id"]) ?? fallbackId,
    type: cuts.label("type", permission["type"]),
    role: cuts.label("role", permission["role"]),
    emailAddress: cuts.label("emailAddress", permission["emailAddress"]),
    domain: cuts.label("domain", permission["domain"]),
    displayName: cuts.label("displayName", permission["displayName"]),
    allowFileDiscovery: bool(permission["allowFileDiscovery"]),
    expirationTime: cuts.label("expirationTime", permission["expirationTime"]),
    // On a shared drive, a role granted by the drive or a parent folder.
    inherited: details.length > 0 ? details.some((detail) => detail["inherited"] === true) : undefined,
    // The folder or shared drive to change instead, since an inherited share
    // cannot be changed or removed here.
    inheritedFrom,
    deleted: permission["deleted"] === true ? true : undefined,
    truncatedFields: cuts.fields,
  });
}

// --- Pages ------------------------------------------------------------------------

/**
 * Where a listing resumes. A result that would outgrow `maxBytes` stops
 * mid-page, and Drive's own token resumes only after a whole page, so the
 * cursor names Drive's token for the page being read, the rows of it already
 * returned, and the page size it was asked with.
 *
 * Resuming by position is only honest on the same page. A mid-page cursor
 * therefore also carries a fingerprint of the page's ids in Drive's order and
 * the last id it returned; if the page reads back any different — a row added,
 * removed, or reordered — the call fails `conflict` rather than skip or repeat
 * a row. A whole-page boundary is Drive's own token and needs neither. Every
 * cursor is bound to its tool and the arguments that decide its rows, so it
 * cannot resume a different listing.
 */
interface Resume {
  token: string | null;
  skip: number;
  size: number;
  /** Fingerprint of the tool and the Drive query it lists. */
  scope: string;
  /**
   * Mid-page only: fingerprints of the page's ids in Drive's order and of the
   * last id returned — Drive's raw ids, before any projection.
   */
  page: string | null;
  last: string | null;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A short SHA-256 fingerprint: 96 bits, as 16 base64url characters. */
async function fingerprint(value: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value))));
  return base64url(digest.subarray(0, 12));
}

function encodeCursor(resume: Resume): string {
  const { token, skip, size, scope, page, last } = resume;
  return base64url(encoder.encode(JSON.stringify([token, skip, size, scope, page, last])));
}

const FINGERPRINT = /^[A-Za-z0-9_-]{16}$/;

function decodeCursor(cursor: string): Resume {
  try {
    const base = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(fromBase64(base + "=".repeat((4 - (base.length % 4)) % 4)));
    const [token, skip, size, scope, page, last] = JSON.parse(json) as unknown[];
    const midPage =
      typeof page === "string" && FINGERPRINT.test(page) && typeof last === "string" && FINGERPRINT.test(last);
    if (
      (token === null || (typeof token === "string" && token !== "")) &&
      Number.isSafeInteger(skip) && (skip as number) >= 0 &&
      Number.isSafeInteger(size) && (size as number) >= 1 && (size as number) <= MAX_PAGE_SIZE &&
      typeof scope === "string" && FINGERPRINT.test(scope) &&
      // A cursor inside a page proves which page; one at a boundary has nothing to prove.
      ((skip as number) > 0 ? midPage : page === null && last === null)
    ) {
      return {
        token: token as string | null,
        skip: skip as number,
        size: size as number,
        scope,
        page: midPage ? (page as string) : null,
        last: midPage ? (last as string) : null,
      };
    }
  } catch {
    // Reported below, as any other cursor this connection did not issue.
  }
  throw new ConnectorCallError(
    "invalid_args",
    "cursor is not a page.nextCursor this connection issued; pass it back unchanged, or omit it to start over.",
  );
}

/**
 * Whether a cursor carrying this page token stays within
 * {@link MAX_CURSOR_CHARS} wherever it resumes, mid-page fingerprints included.
 */
function issuable(token: string): boolean {
  const widest = "A".repeat(16);
  return (
    encodeCursor({ token, skip: MAX_PAGE_SIZE, size: MAX_PAGE_SIZE, scope: widest, page: widest, last: widest })
      .length <= MAX_CURSOR_CHARS
  );
}

/** One page of rows as Drive returned it. */
interface Fetched {
  /** Drive's own ids for the rows, in order, before any projection. */
  ids: string[];
  rows: JsonRecord[];
  next: string | undefined;
  /** Fields beside the rows, such as Drive's incompleteSearch. */
  extra?: JsonRecord | undefined;
}

/**
 * One page of a listing, as many rows as fit `maxBytes` with the whole
 * result — envelope and cursor included — and a cursor that resumes at the
 * first row left out, inside Drive's page or after it.
 *
 * Callers `await` it where they return it: a cursor refused before the first
 * await rejects at once, and workerd reports a rejected promise an async
 * handler merely returns as unhandled before the handler adopts it.
 */
async function pageOf(
  key: string,
  args: JsonRecord,
  /** The tool and every argument that decides which rows, in which order. */
  binding: JsonRecord,
  fetch: (token: string | undefined, size: number) => Promise<Fetched>,
): Promise<JsonRecord> {
  const maxBytes: number = args["maxBytes"] ?? DEFAULT_RESULT_BYTES;
  const size: number = args["limit"] ?? DEFAULT_PAGE_SIZE;
  const scope = await fingerprint({ ...binding, size });
  const resume: Resume = typeof args["cursor"] === "string"
    ? decodeCursor(args["cursor"])
    : { token: null, skip: 0, size, scope, page: null, last: null };
  if (resume.scope !== scope) {
    throw new ConnectorCallError(
      "invalid_args",
      "This cursor belongs to a different listing — another tool, or other arguments. Pass the same arguments it was issued with, or omit cursor to start over.",
    );
  }
  const fetched = await fetch(resume.token ?? undefined, resume.size);
  if (fetched.next !== undefined && !issuable(fetched.next)) {
    throw new ConnectorCallError(
      "connector_call_failed",
      `Drive answered with a next-page token of ${fetched.next.length} characters, too long for a cursor this connection can accept back (${MAX_CURSOR_CHARS}), so the listing cannot be resumed past this page. Narrow the query, or raise limit to take more per page.`,
      { retryable: false },
    );
  }
  // Drive's ids as Drive sent them, so two that differ anywhere differ here.
  const page = await fingerprint(fetched.ids);
  const lasts = await Promise.all(fetched.ids.map((id) => fingerprint(id)));
  if (resume.skip > 0 && (page !== resume.page || lasts[resume.skip - 1] !== resume.last)) {
    throw new ConnectorCallError(
      "conflict",
      `The Drive page this cursor resumes inside has changed since it was read — ${key} were added, removed, or reordered — so resuming by position could skip or repeat some. Nothing was returned; start the listing again without cursor.`,
      { retryable: false },
    );
  }
  const rows = fetched.rows.slice(resume.skip);
  const build = (count: number): JsonRecord => {
    const nextCursor = count < rows.length
      ? encodeCursor({ ...resume, skip: resume.skip + count, page, last: lasts[resume.skip + count - 1] ?? "" })
      : fetched.next
        ? encodeCursor({ token: fetched.next, skip: 0, size: resume.size, scope, page: null, last: null })
        : null;
    return { [key]: rows.slice(0, count), ...fetched.extra, page: { hasMore: nextCursor !== null, nextCursor } };
  };
  if (jsonBytes(build(rows.length)) <= maxBytes) return build(rows.length);
  // The most rows that fit, by binary search; a result's size grows with them.
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(build(middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low === 0) {
    // Every row is bounded well under the smallest maxBytes; only a cursor
    // stuck on a row that never fits could land here, and it must not loop.
    throw new ConnectorCallError(
      "connector_call_failed",
      `One ${key} row does not fit this result's maxBytes of ${maxBytes}; raise maxBytes.`,
      { retryable: false },
    );
  }
  return build(low);
}

// --- Content ----------------------------------------------------------------------

const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/x-yaml",
  "application/yaml",
  "application/x-sh",
  "application/sql",
  "application/csv",
  "application/x-ndjson",
  "image/svg+xml",
]);

function isText(mimeType: string): boolean {
  const type = mimeType.toLowerCase();
  return (
    type.startsWith("text/") ||
    TEXT_TYPES.has(type) ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

/** Whether the UTF-16 unit at `index` opens a surrogate pair that is whole. */
function pairAt(value: string, index: number): boolean {
  const unit = value.charCodeAt(index);
  return unit >= 0xd800 && unit <= 0xdbff && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00;
}

/**
 * The string index just past the first `max` characters, counted as code
 * points — so a cut never splits a surrogate pair — and how many characters
 * the whole string holds.
 */
function codePointCut(value: string, max: number): { end: number; total: number } {
  let index = 0;
  let total = 0;
  let end = value.length;
  while (index < value.length) {
    if (total === max) end = index;
    index += pairAt(value, index) ? 2 : 1;
    total += 1;
  }
  return { end: total > max ? end : value.length, total };
}

/**
 * Cut text to what both bounds allow and say so in the text itself: `max`
 * characters (code points, so never inside a pair), and whatever `fits` — the
 * whole result under `maxBytes` — admits, marker included. `partial` is a body
 * read only in part, which is cut whatever its length: there is more past it.
 */
function capped(
  body: string,
  max: number,
  partial: { size: number | undefined } | undefined,
  fits: (content: string) => boolean,
): { content: string; contentTruncated: boolean } {
  const { total } = codePointCut(body, max);
  if (total <= max && !partial && fits(body)) return { content: body, contentTruncated: false };
  const of = partial
    ? partial.size !== undefined && partial.size > 0
      ? `a ${partial.size}-byte file`
      : "a larger file"
    : `${total} characters`;
  const cut = (count: number, raise: string) =>
    `${body.slice(0, codePointCut(body, count).end)}\n[… truncated: ${count} characters of ${of} shown; raise ${raise} to read more]`;
  const byChars = cut(Math.min(total, max), `maxChars (up to ${MAX_CONTENT_CHARS})`);
  if (fits(byChars)) return { content: byChars, contentTruncated: true };
  // The bytes bind first: the most characters that fit, by binary search.
  const raise = `maxBytes (up to ${MAX_RESULT_BYTES}, for a direct call_tool only)`;
  let low = 0;
  let high = Math.min(total, max);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(cut(middle, raise))) low = middle;
    else high = middle - 1;
  }
  return { content: cut(low, raise), contentTruncated: true };
}

function charsetOf(contentType: string | undefined): string {
  return /charset="?([^";\s]+)"?/i.exec(contentType ?? "")?.[1] ?? "utf-8";
}

/** Bytes as text in the charset the response declared, where the runtime knows it. */
function decodeIn(bytes: Uint8Array, contentType: string | undefined): string {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new ConnectorCallError("invalid_args", "contentBase64 is not valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Why the content tool returns no content for a file, as the note says it.
 * Only a well-formed id or media type is interpolated; anything else Drive
 * sends is named by kind, so a note stays a sentence.
 */
function unreadable(file: JsonRecord): string | undefined {
  const mimeType = String(file["mimeType"] ?? "");
  if (mimeType === FOLDER) return "A folder has no content; list it with list_folder_items.";
  if (mimeType === SHORTCUT) {
    const target = text(asRecord(file["shortcutDetails"])["targetId"]);
    const named = target !== undefined && DRIVE_ID.test(target) ? ` (${target})` : "";
    return `A shortcut has no content of its own; read its target${named} instead.`;
  }
  if (mimeType === "application/vnd.google-apps.drawing") {
    return "Drawings export only as images or PDF; this connection reads no drawing. Open webViewLink.";
  }
  if (mimeType.startsWith(NATIVE) && !EXPORTS[mimeType]) {
    const named = mimeType.length <= 255 && MEDIA_TYPE.test(mimeType) ? mimeType : "this Google file type";
    return `Drive exports no text for ${named}; open webViewLink.`;
  }
  if (asRecord(file["capabilities"])["canDownload"] === false) {
    return "The owner has disabled download, print, and copy for this account; Drive refuses its content.";
  }
  return undefined;
}

/**
 * The bytes a text read keeps: enough for `maxChars` of UTF-8 at four bytes
 * each and one more character, so a body this long is always cut.
 */
function textBudget(maxChars: number): number {
  return maxChars * 4 + 4;
}

/**
 * A media download of at most `limit` bytes, and whether the file had more.
 *
 * The limit is enforced on the response, never on the size metadata
 * reported: that is a separate read, and a file can grow, shrink, or empty
 * between the two. The range asks for one byte past the limit, so a file that
 * has more says so by sending it, and the shared client's `maxBytes` reads the
 * body only that far and cancels the rest unread — so a server that ignores
 * the range, or a body past the client's own ceiling, costs no more than the
 * limit either.
 *
 * The range is sent even when the metadata says the file is empty, since that
 * may no longer be so. A range from byte 0 of a file with no bytes is answered
 * 416 with `Content-Range: bytes *\/0`, which the client returns as an empty
 * body: a verified empty file, not a failure. Any other 416 still fails.
 */
async function download(
  client: GoogleWorkspaceClient,
  ctx: ConnectorContext,
  path: string,
  limit: number,
): Promise<{ bytes: Uint8Array; more: boolean; contentType: string | undefined }> {
  const read = await client.bytes(
    {
      method: "GET",
      path,
      query: { ...ALL_DRIVES, alt: "media" },
      headers: { Range: `bytes=0-${limit}` },
    },
    ctx,
    "*/*",
    { maxBytes: limit },
  );
  return { bytes: read.bytes.subarray(0, limit), more: read.truncated, contentType: read.contentType };
}

async function readContent(
  client: GoogleWorkspaceClient,
  ctx: ConnectorContext,
  fileId: string,
  maxChars: number,
  maxBytes: number,
): Promise<JsonRecord> {
  const filePath = `/files/${encodeURIComponent(fileId)}`;
  const file = asRecord(
    await client.json(
      {
        method: "GET",
        path: filePath,
        query: {
          ...ALL_DRIVES,
          fields: "id,name,mimeType,size,webViewLink,capabilities(canDownload),shortcutDetails(targetId)",
        },
      },
      ctx,
    ),
  );
  const mimeType = String(file["mimeType"] ?? "application/octet-stream");
  const size = sizeOf(file["size"]);
  const cuts = new Cuts();
  const base = compact({
    id: cuts.id("id", file["id"]) ?? fileId,
    name: cuts.label("name", file["name"], ROW_NAME_BYTES),
    mimeType: cuts.label("mimeType", mimeType),
    size,
    webViewLink: cuts.label("webViewLink", file["webViewLink"]),
    truncatedFields: cuts.fields,
  });
  const refusal = unreadable(file);
  if (refusal) return { ...base, format: "unavailable", contentTruncated: false, note: refusal };
  /** Whether the whole result, with this content, stays under maxBytes. */
  const within = (result: JsonRecord) => (content: string) => jsonBytes({ ...result, content }) <= maxBytes;

  const exported = EXPORTS[mimeType];
  if (exported) {
    // Past Drive's 10 MB export limit, the shared client names Google's
    // exportSizeLimitExceeded itself; nothing here guesses at a 403.
    const { text: body } = await client.text(
      { method: "GET", path: `${filePath}/export`, query: { mimeType: exported.mimeType } },
      ctx,
      exported.mimeType,
    );
    const result = compact({
      ...base,
      format: exported.format,
      exportedAs: exported.mimeType,
      content: "",
      contentTruncated: false,
      note: exported.note,
    });
    return { ...result, ...capped(body, maxChars, undefined, within(result)) };
  }

  if (isText(mimeType)) {
    const read = await download(client, ctx, filePath, textBudget(maxChars));
    let body = decodeIn(read.bytes, read.contentType);
    // A cut can land inside a character; drop the half, never show it.
    if (read.more) body = body.replace(/(?:\uFFFD|[\uD800-\uDBFF])$/, "");
    const result = { ...base, format: "text", content: "", contentTruncated: false };
    return { ...result, ...capped(body, maxChars, read.more ? { size } : undefined, within(result)) };
  }

  // Base64 is four characters per three bytes and never escaped, so the file
  // bytes that fit are known before anything is downloaded.
  const envelope = jsonBytes({ ...base, format: "base64", content: "", contentTruncated: false });
  const fitting = Math.floor(Math.max(0, maxBytes - envelope) / 4) * 3;
  const limit = Math.min(BINARY_INLINE_BYTES, fitting);
  const tooLarge = (bytes: string) => ({
    ...base,
    format: "unavailable" as const,
    contentTruncated: false,
    note:
      limit < BINARY_INLINE_BYTES
        ? `A binary file of ${bytes} does not fit this result's maxBytes (${maxBytes}), which holds ${limit} bytes of file; no content is returned. Raise maxBytes, up to ${MAX_RESULT_BYTES} for a direct call_tool only, to read up to ${BINARY_INLINE_BYTES} bytes, or open webViewLink.`
        : `A binary file of ${bytes} is past this connection's ${BINARY_INLINE_BYTES}-byte inline cap; no content is returned. Open webViewLink.`,
  });
  // Metadata that already says too large saves the download; metadata that
  // says small is not trusted, and the download is held to the cap itself.
  if (size !== undefined && size > limit) return tooLarge(`${size} bytes`);
  const read = await download(client, ctx, filePath, limit);
  if (read.more) return tooLarge(`more than ${limit} bytes`);
  return { ...base, format: "base64", content: base64(read.bytes), contentTruncated: false };
}

// --- Writes -----------------------------------------------------------------------

/**
 * Run a write that adds something, saying what to check before repeating it
 * when it may have landed: whenever the request left connecta and Google did
 * not refuse it. That is no answer (`awaiting-response`), an unfollowed
 * redirect (`redirected`), a 5xx (`server-error`) — each of which leaves the
 * outcome unknown — or a 2xx whose reply broke (`reading-body`), which
 * probably applied. The shared client already says which, in its own words,
 * and makes the failure non-retryable; this adds only the read that tells,
 * because a repeat of an additive write is not harmless — it makes a second
 * file, folder, copy, or share. The code is kept, so core still reads the
 * outcome as unknown. A refusal, or a failure before anything was sent,
 * passes through untouched.
 */
async function adding<T>(work: () => Promise<T>, check: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const outcome = googleOutcomeOf(error);
    if (
      error instanceof ConnectorCallError &&
      error.code === "connector_call_failed" &&
      outcome?.dispatched === true &&
      outcome.phase !== "refused" &&
      outcome.phase !== "before-send"
    ) {
      throw new ConnectorCallError(error.code, `${error.message} ${check}`, { retryable: false, cause: error });
    }
    throw error;
  }
}

/**
 * Writes safe to send twice: each sets fixed values — a name, a description,
 * the trashed flag, a role, the whole content — so a second identical request
 * leaves the file as the first did, and a 5xx stays a retryable outage. Never
 * a create, copy, share, permission delete, or move, whose second send makes a
 * second thing, fails differently, or acts on parents the first send changed.
 */
const IDEMPOTENT = { idempotent: true } as const;

const CHECK_CREATED =
  "Find it with search_files or list_folder_items before creating it again: a second call makes a second one.";

// --- Uploads ----------------------------------------------------------------------

const MEDIA_TYPE = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/;

function mediaType(value: unknown, fallback: string): string {
  const type = typeof value === "string" ? value : fallback;
  if (!MEDIA_TYPE.test(type)) {
    throw new ConnectorCallError("invalid_args", "mimeType must be a bare media type such as text/plain.");
  }
  if (type.startsWith(NATIVE)) {
    throw new ConnectorCallError(
      "invalid_args",
      "mimeType names the uploaded content, never a Google type; use convertTo to create a Google Doc, Sheet, or Slides file, or create_folder for a folder.",
    );
  }
  return type;
}

/** The uploaded bytes and their media type, from exactly one of the two fields. */
function media(args: JsonRecord): { bytes: Uint8Array; type: string } | undefined {
  const hasText = typeof args["content"] === "string";
  const hasBinary = typeof args["contentBase64"] === "string";
  if (hasText && hasBinary) {
    throw new ConnectorCallError("invalid_args", "Pass content or contentBase64, not both.");
  }
  if (hasText) {
    return {
      bytes: new TextEncoder().encode(args["content"]),
      type: mediaType(args["mimeType"], "text/plain"),
    };
  }
  if (hasBinary) {
    const bytes = fromBase64(args["contentBase64"]);
    if (bytes.length > BINARY_INLINE_BYTES) {
      throw new ConnectorCallError(
        "invalid_args",
        `contentBase64 decodes to ${bytes.length} bytes, past this connection's ${BINARY_INLINE_BYTES}-byte upload cap.`,
      );
    }
    return { bytes, type: mediaType(args["mimeType"], "application/octet-stream") };
  }
  return undefined;
}

/**
 * One `multipart/related` body: the metadata as JSON, then the media. Built
 * whole as bytes, never a stream, so the shared client's single 401 replay
 * can send it again unchanged.
 */
function multipart(metadata: JsonRecord, content: { bytes: Uint8Array; type: string }): {
  body: Uint8Array;
  contentType: string;
} {
  const boundary = `connecta-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${content.type}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + content.bytes.length + tail.length);
  body.set(head, 0);
  body.set(content.bytes, head.length);
  body.set(tail, head.length + content.bytes.length);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

/** The upload host beside an API root: `…/drive/v3` → `…/upload/drive/v3`. */
function uploadBaseUrl(apiBase: string): string {
  const url = new URL(apiBase);
  return `${url.origin}/upload${url.pathname.replace(/\/+$/, "")}`;
}

// --- Schemas ----------------------------------------------------------------------

function input(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const ID_PATTERN = "^[A-Za-z0-9_-]+$";

function idProperty(description: string): JsonSchema {
  return { type: "string", minLength: 1, maxLength: 256, pattern: ID_PATTERN, description };
}

const FILE_ID = idProperty("File or folder id, from search_files, list_folder_items, or a Drive URL's /d/<id>.");

const CURSOR_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_CURSOR_CHARS,
  pattern: "^[A-Za-z0-9_-]+$",
  description: "Opaque page.nextCursor from the previous page. Pass it back unchanged with the same arguments.",
};

const MAX_BYTES_PROPERTY: JsonSchema = {
  type: "integer",
  minimum: MIN_RESULT_BYTES,
  maximum: MAX_RESULT_BYTES,
  description: `Serialized bytes of the whole result; defaults to ${DEFAULT_RESULT_BYTES}, what execute_code can receive. Raise it, to ${MAX_RESULT_BYTES}, only for a direct call_tool read.`,
};

const LIMIT_PROPERTY: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PAGE_SIZE,
  description: `Rows per page, 1 to ${MAX_PAGE_SIZE}; defaults to ${DEFAULT_PAGE_SIZE}. Connecta's cap, below Drive's 1,000.`,
};

const ORDER_PROPERTY: JsonSchema = {
  type: "string",
  enum: ["modifiedTime desc", "modifiedTime", "name", "name desc", "createdTime desc", "folder,name"],
  description: "Sort order. Drive refuses any sort on a fullText query, which comes back by relevance.",
};

const INCLUDE_TRASHED: JsonSchema = {
  type: "boolean",
  description: "Include trashed files, which are left out by default.",
};

const NAME_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1000,
  pattern: "^[^\\r\\n]*$",
  description: "File name as Drive shows it, extension included where it has one.",
};

const DESCRIPTION_PROPERTY: JsonSchema = {
  type: "string",
  maxLength: 10_000,
  description: "Free-text description shown in Drive's details pane.",
};

const PARENT_PROPERTY: JsonSchema = idProperty("Folder id to place it in, or root for My Drive; defaults to My Drive.");

const CONTENT_PROPERTY: JsonSchema = {
  type: "string",
  maxLength: MAX_UPLOAD_CHARS,
  description: `Text content, up to ${MAX_UPLOAD_CHARS} characters (connecta's cap). Exclusive with contentBase64.`,
};

const CONTENT_BASE64_PROPERTY: JsonSchema = {
  type: "string",
  maxLength: MAX_UPLOAD_BASE64,
  pattern: "^[A-Za-z0-9+/]*={0,2}$",
  description: `Binary content as base64, up to ${BINARY_INLINE_BYTES} bytes decoded (connecta's cap; Drive allows 5 MB). Exclusive with content.`,
};

const MIME_PROPERTY: JsonSchema = {
  type: "string",
  maxLength: 255,
  pattern: "^[A-Za-z0-9][\\w.+-]*/[A-Za-z0-9][\\w.+-]*$",
  description: "Media type of the content: text/plain, text/markdown, text/csv, application/pdf. Never a Google type.",
};

const ROLE_PROPERTY: JsonSchema = {
  type: "string",
  enum: ["reader", "commenter", "writer", "fileOrganizer", "organizer"],
  description: "Access granted. fileOrganizer and organizer exist only on shared drives. Ownership is never granted here.",
};

const PERMISSION_ID = idProperty("Permission id from list_permissions.");

const TRUNCATED_FIELDS: JsonSchema = {
  type: "array",
  items: { type: "string" },
  description:
    "Fields this result shortened (a string ending in …), capped (a list past ten), or left out (a malformed id). get_file keeps longer names.",
};

const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hasMore: { type: "boolean" },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["hasMore", "nextCursor"],
};

const FILE_PROPERTIES: Record<string, JsonSchema> = {
  id: { type: "string" },
  name: { type: "string" },
  mimeType: { type: "string" },
  parents: { type: "array", items: { type: "string" } },
  driveId: { type: "string" },
  size: { type: "integer" },
  modifiedTime: { type: "string" },
  owners: { type: "array", items: { type: "string" } },
  trashed: { type: "boolean" },
  webViewLink: { type: "string" },
  shortcutTargetId: { type: "string" },
  shortcutTargetMimeType: { type: "string" },
  truncatedFields: TRUNCATED_FIELDS,
};

// Nothing is required: Google's ProtoJSON omits an empty field, and a
// projection says only what the response said.
const FILE_SCHEMA: JsonSchema = { type: "object", properties: FILE_PROPERTIES };

const FILE_DETAIL_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    ...FILE_PROPERTIES,
    description: { type: "string" },
    createdTime: { type: "string" },
    modifiedBy: { type: "string" },
    shared: { type: "boolean" },
    starred: { type: "boolean" },
    capabilities: {
      type: "object",
      properties: Object.fromEntries(CAPABILITIES.map((name) => [name, { type: "boolean" }])),
    },
  },
};

const FILE_LIST_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    files: { type: "array", items: FILE_SCHEMA },
    incompleteSearch: { type: "boolean" },
    page: PAGE_SCHEMA,
  },
  required: ["files", "page"],
};

const PERMISSION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: ["user", "group", "domain", "anyone"] },
    role: { type: "string" },
    emailAddress: { type: "string" },
    domain: { type: "string" },
    displayName: { type: "string" },
    allowFileDiscovery: { type: "boolean" },
    expirationTime: { type: "string" },
    inherited: { type: "boolean" },
    inheritedFrom: { type: "string" },
    deleted: { type: "boolean" },
    truncatedFields: TRUNCATED_FIELDS,
  },
};

// --- Tools ------------------------------------------------------------------------

function tools(client: GoogleWorkspaceClient, upload: GoogleWorkspaceClient): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;
  // Additive: creates something new that discloses nothing, and changes
  // nothing that existed.
  const additive = { readOnlyHint: false, destructiveHint: false } as const;
  // Overwrites, moves, trashes, or changes who can see a file.
  const destructive = { readOnlyHint: false, destructiveHint: true } as const;
  const filePath = (id: string) => `/files/${encodeURIComponent(id)}`;

  const list = (
    ctx: ConnectorContext,
    tool: string,
    args: JsonRecord,
    query: Record<string, string | number | boolean | undefined>,
  ) =>
    // The Drive query decides the rows: folder, search, corpus, drive, order.
    pageOf("files", args, { tool, ...query }, async (pageToken, pageSize) => {
      const listing = asRecord(
        await client.json(
          {
            method: "GET",
            path: "/files",
            query: {
              ...ALL_DRIVES,
              includeItemsFromAllDrives: true,
              fields: `nextPageToken,incompleteSearch,files(${SUMMARY_FIELDS})`,
              ...query,
              pageSize,
              pageToken,
            },
          },
          ctx,
        ),
      );
      return {
        ids: asArray(listing["files"]).map((file) => String(asRecord(file)["id"] ?? "")),
        rows: asArray(listing["files"]).map((file) => projectFile(file)),
        next: text(listing["nextPageToken"]),
        // Drive's own truncation: it stopped before searching every corpus.
        extra: listing["incompleteSearch"] === true ? { incompleteSearch: true } : undefined,
      };
    });

  const patch = async (
    ctx: ConnectorContext,
    fileId: string,
    body: JsonRecord,
    query: Record<string, string | undefined> = {},
    options: { idempotent?: true } = {},
  ) =>
    projectFile(
      await client.json(
        {
          method: "PATCH",
          path: filePath(fileId),
          query: { ...ALL_DRIVES, fields: SUMMARY_FIELDS, ...query },
          body,
        },
        ctx,
        options,
      ),
      fileId,
    );

  return [
    {
      name: "search_files",
      description:
        "Search Drive files the user can open with Drive query syntax, returning name, type, folder, size, and link per file. Content needs get_file_content.",
      annotations: readOnly,
      inputSchema: input(
        {
          query: {
            type: "string",
            maxLength: 2048,
            description:
              "Drive query: name contains 'budget', fullText contains 'elders', mimeType = 'application/pdf', modifiedTime > '2026-01-01T00:00:00', 'me' in owners. Omit for everything.",
          },
          corpora: {
            type: "string",
            enum: ["user", "domain", "drive", "allDrives"],
            description:
              "Where to look: user (default; My Drive and shared with me), drive (one shared drive, with driveId), allDrives (slower, may be incomplete), domain.",
          },
          driveId: idProperty("Shared drive id from list_shared_drives; required with corpora drive, refused otherwise."),
          orderBy: ORDER_PROPERTY,
          includeTrashed: INCLUDE_TRASHED,
          limit: LIMIT_PROPERTY,
          cursor: CURSOR_PROPERTY,
          maxBytes: MAX_BYTES_PROPERTY,
        },
        [],
      ),
      outputSchema: FILE_LIST_SCHEMA,
      handler: async (args, ctx) => {
        const corpora = args["corpora"] ?? "user";
        if ((corpora === "drive") !== (args["driveId"] !== undefined)) {
          throw new ConnectorCallError(
            "invalid_args",
            "driveId goes with corpora drive and only with it; find shared drive ids with list_shared_drives.",
          );
        }
        const query = text(args["query"]);
        const q = args["includeTrashed"] === true
          ? query
          : query ? `(${query}) and trashed = false` : "trashed = false";
        return await list(ctx, "search_files", args, { q, corpora, driveId: args["driveId"], orderBy: args["orderBy"] });
      },
    },
    {
      name: "list_folder_items",
      description:
        "List the files and folders directly inside one Drive folder, in My Drive or a shared drive. Not recursive: list a subfolder by its own id.",
      annotations: readOnly,
      inputSchema: input(
        {
          folderId: idProperty("Folder id, a shared drive id for its top level, or root for My Drive."),
          orderBy: { ...ORDER_PROPERTY, description: "Sort order; defaults to folders first, then by name." },
          includeTrashed: INCLUDE_TRASHED,
          limit: LIMIT_PROPERTY,
          cursor: CURSOR_PROPERTY,
          maxBytes: MAX_BYTES_PROPERTY,
        },
        ["folderId"],
      ),
      outputSchema: FILE_LIST_SCHEMA,
      handler: async (args, ctx) => {
        const folderId = String(args["folderId"]);
        // A shared drive folder is listed within its drive, which Drive
        // searches only when asked by id; the folder itself says which.
        let driveId: string | undefined;
        if (folderId !== "root") {
          const folder = asRecord(
            await client.json(
              {
                method: "GET",
                path: filePath(folderId),
                query: { ...ALL_DRIVES, fields: "id,mimeType,driveId" },
              },
              ctx,
            ),
          );
          if (folder["mimeType"] !== FOLDER) {
            throw new ConnectorCallError(
              "invalid_args",
              `${folderId} is not a folder (${String(folder["mimeType"] ?? "unknown type")}); read it with get_file or get_file_content.`,
            );
          }
          driveId = text(folder["driveId"]);
        }
        const q = `'${folderId}' in parents${args["includeTrashed"] === true ? "" : " and trashed = false"}`;
        return await list(ctx, "list_folder_items", args, {
          q,
          corpora: driveId ? "drive" : "user",
          driveId,
          orderBy: args["orderBy"] ?? "folder,name",
        });
      },
    },
    {
      name: "get_file",
      description:
        "Get one Drive file's metadata: name, type, folder, owners, sharing flag, description, and what this user may do with it. Never its content.",
      annotations: readOnly,
      inputSchema: input({ fileId: FILE_ID }, ["fileId"]),
      outputSchema: FILE_DETAIL_SCHEMA,
      handler: async (args, ctx) =>
        projectFileDetail(
          await client.json(
            {
              method: "GET",
              path: filePath(args["fileId"]),
              query: { ...ALL_DRIVES, fields: DETAIL_FIELDS },
            },
            ctx,
          ),
          String(args["fileId"]),
        ),
    },
    {
      name: "get_file_content",
      description:
        "Read a Drive file's content: Docs as Markdown, Sheets as CSV of the first sheet, Slides as text, text files as text, small binaries as base64. Never drawings or folders.",
      annotations: readOnly,
      inputSchema: input(
        {
          fileId: FILE_ID,
          maxChars: {
            type: "integer",
            minimum: 1,
            maximum: MAX_CONTENT_CHARS,
            description: `Characters (code points) of text kept, 1 to ${MAX_CONTENT_CHARS}; defaults to ${DEFAULT_CONTENT_CHARS}. Longer text ends with a truncation marker. Binaries ignore it.`,
          },
          maxBytes: MAX_BYTES_PROPERTY,
        },
        ["fileId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          mimeType: { type: "string" },
          size: { type: "integer" },
          truncatedFields: TRUNCATED_FIELDS,
          webViewLink: { type: "string" },
          format: { type: "string", enum: ["markdown", "csv", "text", "base64", "unavailable"] },
          exportedAs: { type: "string" },
          content: { type: "string" },
          contentTruncated: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["id", "format", "contentTruncated"],
      },
      handler: async (args, ctx) =>
        await readContent(
          client,
          ctx,
          String(args["fileId"]),
          typeof args["maxChars"] === "number" ? args["maxChars"] : DEFAULT_CONTENT_CHARS,
          typeof args["maxBytes"] === "number" ? args["maxBytes"] : DEFAULT_RESULT_BYTES,
        ),
    },
    {
      name: "list_permissions",
      description:
        "List who a Drive file or folder is shared with: each permission's id, type, role, and address or domain. Use the ids with update_permission or delete_permission.",
      annotations: readOnly,
      inputSchema: input(
        { fileId: FILE_ID, limit: LIMIT_PROPERTY, cursor: CURSOR_PROPERTY, maxBytes: MAX_BYTES_PROPERTY },
        ["fileId"],
      ),
      outputSchema: {
        type: "object",
        properties: { permissions: { type: "array", items: PERMISSION_SCHEMA }, page: PAGE_SCHEMA },
        required: ["permissions", "page"],
      },
      handler: async (args, ctx) =>
        await pageOf("permissions", args, { tool: "list_permissions", fileId: args["fileId"] }, async (pageToken, pageSize) => {
          const listing = asRecord(
            await client.json(
              {
                method: "GET",
                path: `${filePath(args["fileId"])}/permissions`,
                query: {
                  ...ALL_DRIVES,
                  fields: `nextPageToken,permissions(${PERMISSION_FIELDS})`,
                  pageSize,
                  pageToken,
                },
              },
              ctx,
            ),
          );
          return {
            ids: asArray(listing["permissions"]).map((permission) => String(asRecord(permission)["id"] ?? "")),
            rows: asArray(listing["permissions"]).map((permission) => projectPermission(permission)),
            next: text(listing["nextPageToken"]),
          };
        }),
    },
    {
      name: "list_shared_drives",
      description:
        "List the shared drives the user is a member of, with their ids for search_files and list_folder_items. Not the files inside them.",
      annotations: readOnly,
      inputSchema: input(
        {
          query: {
            type: "string",
            maxLength: 1024,
            description: "Shared drive query, e.g. name contains 'Finance'. Omit for every drive.",
          },
          limit: LIMIT_PROPERTY,
          cursor: CURSOR_PROPERTY,
          maxBytes: MAX_BYTES_PROPERTY,
        },
        [],
      ),
      outputSchema: {
        type: "object",
        properties: {
          drives: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                hidden: { type: "boolean" },
                truncatedFields: TRUNCATED_FIELDS,
              },
            },
          },
          page: PAGE_SCHEMA,
        },
        required: ["drives", "page"],
      },
      handler: async (args, ctx) =>
        await pageOf("drives", args, { tool: "list_shared_drives", q: args["query"] }, async (pageToken, pageSize) => {
          const listing = asRecord(
            await client.json(
              {
                method: "GET",
                path: "/drives",
                query: {
                  q: args["query"],
                  fields: "nextPageToken,drives(id,name,hidden)",
                  pageSize,
                  pageToken,
                },
              },
              ctx,
            ),
          );
          return {
            ids: asArray(listing["drives"]).map((value) => String(asRecord(value)["id"] ?? "")),
            rows: asArray(listing["drives"]).map((value) => {
              const sharedDrive = asRecord(value);
              const cuts = new Cuts();
              return compact({
                id: cuts.id("id", sharedDrive["id"]),
                name: cuts.label("name", sharedDrive["name"]),
                hidden: sharedDrive["hidden"] === true ? true : undefined,
                truncatedFields: cuts.fields,
              });
            }),
            next: text(listing["nextPageToken"]),
          };
        }),
    },
    {
      name: "create_folder",
      description: "Create a new, empty Drive folder, in My Drive or inside another folder. Shares nothing beyond what the parent folder already grants.",
      annotations: additive,
      inputSchema: input(
        { name: NAME_PROPERTY, parentId: PARENT_PROPERTY, description: DESCRIPTION_PROPERTY },
        ["name"],
      ),
      outputSchema: FILE_SCHEMA,
      handler: async (args, ctx) =>
        projectFile(
          await adding(
            () =>
              client.json(
                {
                  method: "POST",
                  path: "/files",
                  query: { ...ALL_DRIVES, fields: SUMMARY_FIELDS },
                  body: compact({
                    name: args["name"],
                    mimeType: FOLDER,
                    parents: args["parentId"] ? [args["parentId"]] : undefined,
                    description: args["description"],
                  }),
                },
                ctx,
              ),
            CHECK_CREATED,
          ),
        ),
    },
    {
      name: "create_file",
      description:
        "Create a Drive file from text or base64 content, or an empty one; convertTo makes a Google Doc, Sheet, or Slides file. Whoever can see its folder can see it.",
      // Destructive though nothing is overwritten: a new file takes its
      // folder's sharing, so content written into a shared folder is
      // disclosed to everyone it is shared with, at once.
      annotations: destructive,
      inputSchema: input(
        {
          name: NAME_PROPERTY,
          parentId: PARENT_PROPERTY,
          content: CONTENT_PROPERTY,
          contentBase64: CONTENT_BASE64_PROPERTY,
          mimeType: { ...MIME_PROPERTY, description: `${MIME_PROPERTY.description} Defaults to text/plain or application/octet-stream.` },
          convertTo: {
            type: "string",
            enum: ["document", "spreadsheet", "presentation"],
            description: "Import as a Google type: markdown, HTML, or text to document; CSV to spreadsheet. Without content, an empty one.",
          },
          description: DESCRIPTION_PROPERTY,
        },
        ["name"],
      ),
      outputSchema: FILE_SCHEMA,
      handler: async (args, ctx) => {
        const content = media(args);
        const convert = typeof args["convertTo"] === "string" ? CONVERSIONS[args["convertTo"]] : undefined;
        const metadata = compact({
          name: args["name"],
          parents: args["parentId"] ? [args["parentId"]] : undefined,
          description: args["description"],
          mimeType: convert ?? content?.type,
        });
        if (!content) {
          if (args["mimeType"] !== undefined) {
            throw new ConnectorCallError("invalid_args", "mimeType describes content; pass content or contentBase64 with it.");
          }
          return projectFile(
            await adding(
              () =>
                client.json(
                  { method: "POST", path: "/files", query: { ...ALL_DRIVES, fields: SUMMARY_FIELDS }, body: metadata },
                  ctx,
                ),
              CHECK_CREATED,
            ),
          );
        }
        const framed = multipart(metadata, content);
        return projectFile(
          await adding(
            () =>
              upload.json(
                {
                  method: "POST",
                  path: "/files",
                  query: { ...ALL_DRIVES, uploadType: "multipart", fields: SUMMARY_FIELDS },
                  headers: { "Content-Type": framed.contentType },
                  rawBody: framed.body as BodyInit,
                },
                ctx,
              ),
            CHECK_CREATED,
          ),
        );
      },
    },
    {
      name: "update_file_content",
      description:
        "Replace a Drive file's entire content with new text or base64 bytes; the old content survives only in Drive's version history. Keeps name, folder, and sharing.",
      // Destructive: the whole content is overwritten. Drive keeps revisions
      // for a while, but this connection offers no way back to one.
      annotations: destructive,
      inputSchema: input(
        {
          fileId: FILE_ID,
          content: CONTENT_PROPERTY,
          contentBase64: CONTENT_BASE64_PROPERTY,
          mimeType: {
            ...MIME_PROPERTY,
            description:
              "Media type of the new content: usually the file's own, text/markdown for a Google Doc, text/csv for a Sheet (replacing every tab).",
          },
        },
        ["fileId", "mimeType"],
      ),
      outputSchema: FILE_SCHEMA,
      handler: async (args, ctx) => {
        const content = media(args);
        if (!content) {
          throw new ConnectorCallError("invalid_args", "Pass content or contentBase64: the file's new content.");
        }
        return projectFile(
          await upload.json(
            {
              method: "PATCH",
              path: filePath(args["fileId"]),
              query: { ...ALL_DRIVES, uploadType: "media", fields: SUMMARY_FIELDS },
              headers: { "Content-Type": content.type },
              rawBody: content.bytes as BodyInit,
            },
            ctx,
            // The whole content, replaced: a second send leaves the same file.
            IDEMPOTENT,
          ),
          String(args["fileId"]),
        );
      },
    },
    {
      name: "update_file",
      description:
        "Rename a Drive file or folder, or replace its description. Never its content, folder, or sharing: use update_file_content, move_file, or share_file.",
      // Destructive: the old name or description is overwritten, and a
      // rename can break what finds the file by name.
      annotations: destructive,
      inputSchema: input(
        { fileId: FILE_ID, name: NAME_PROPERTY, description: DESCRIPTION_PROPERTY },
        ["fileId"],
      ),
      outputSchema: FILE_SCHEMA,
      handler: async (args, ctx) => {
        if (args["name"] === undefined && args["description"] === undefined) {
          throw new ConnectorCallError("invalid_args", "Pass name, description, or both.");
        }
        return patch(ctx, args["fileId"], compact({ name: args["name"], description: args["description"] }), {}, IDEMPOTENT);
      },
    },
    {
      name: "move_file",
      description:
        "Move a Drive file or folder into another folder or shared drive, out of the folder it is in now. Can change who has access to it.",
      // Destructive: a file inherits sharing from its folder, so a move can
      // revoke access granted through the old folder or grant it through the
      // new one, and moving into a shared drive hands ownership to the drive.
      annotations: destructive,
      inputSchema: input(
        {
          fileId: FILE_ID,
          folderId: idProperty("Destination folder id, a shared drive id for its top level, or root for My Drive."),
        },
        ["fileId", "folderId"],
      ),
      outputSchema: FILE_SCHEMA,
      handler: async (args, ctx) => {
        const current = asRecord(
          await client.json(
            { method: "GET", path: filePath(args["fileId"]), query: { ...ALL_DRIVES, fields: "parents" } },
            ctx,
          ),
        );
        const from = idsOf(current["parents"]).filter((id) => id !== args["folderId"]);
        return patch(ctx, args["fileId"], {}, {
          addParents: args["folderId"],
          removeParents: from.length > 0 ? from.join(",") : undefined,
        });
      },
    },
    {
      name: "copy_file",
      description:
        "Copy a Drive file into a new file, optionally renamed or in another folder. The copy is shared like its folder, not like the original; no folders.",
      // Destructive though nothing is overwritten: the copy takes its
      // destination folder's sharing, so a private file copied into a shared
      // folder is disclosed — the same exposure move_file carries.
      annotations: destructive,
      inputSchema: input(
        {
          fileId: FILE_ID,
          name: { ...NAME_PROPERTY, description: "Name of the copy; defaults to Drive's \"Copy of …\"." },
          parentId: { ...PARENT_PROPERTY, description: "Folder for the copy; defaults to the original's." },
        },
        ["fileId"],
      ),
      outputSchema: FILE_SCHEMA,
      handler: async (args, ctx) =>
        projectFile(
          await adding(
            () =>
              client.json(
                {
                  method: "POST",
                  path: `${filePath(args["fileId"])}/copy`,
                  query: { ...ALL_DRIVES, fields: SUMMARY_FIELDS },
                  body: compact({ name: args["name"], parents: args["parentId"] ? [args["parentId"]] : undefined }),
                },
                ctx,
              ),
            "Look for the copy with search_files or list_folder_items before copying again: a second call makes a second copy.",
          ),
        ),
    },
    {
      name: "trash_file",
      description:
        "Move a Drive file or folder to the trash, where Drive deletes it for good after 30 days; restore_file undoes it. Never deletes permanently itself.",
      // Destructive: collaborators lose the file at once, and the trash
      // empties itself.
      annotations: destructive,
      inputSchema: input({ fileId: FILE_ID }, ["fileId"]),
      outputSchema: FILE_SCHEMA,
      handler: async (args, ctx) => patch(ctx, args["fileId"], { trashed: true }, {}, IDEMPOTENT),
    },
    {
      name: "restore_file",
      description: "Restore (untrash) a trashed Drive file or folder to where it was. Cannot recover a file already deleted from the trash.",
      // Additive: brings back exactly what was there, losing nothing.
      annotations: additive,
      inputSchema: input({ fileId: FILE_ID }, ["fileId"]),
      outputSchema: FILE_SCHEMA,
      handler: async (args, ctx) => patch(ctx, args["fileId"], { trashed: false }, {}, IDEMPOTENT),
    },
    {
      name: "share_file",
      description:
        "Share a Drive file or folder with a user, group, domain, or anyone with the link, at a role up to writer. Sends no email unless asked; never transfers ownership.",
      annotations: destructive,
      inputSchema: input(
        {
          fileId: FILE_ID,
          type: {
            type: "string",
            enum: ["user", "group", "domain", "anyone"],
            description: "Grantee kind: user or group needs emailAddress, domain needs domain, anyone means anyone with the link.",
          },
          role: ROLE_PROPERTY,
          emailAddress: {
            type: "string",
            minLength: 3,
            maxLength: 320,
            pattern: "^[^\\s@]+@[^\\s@]+$",
            description: "The user's or group's email address, for type user or group only.",
          },
          domain: {
            type: "string",
            minLength: 1,
            maxLength: 253,
            pattern: "^[A-Za-z0-9.-]+$",
            description: "The Workspace domain, for type domain only.",
          },
          allowFileDiscovery: {
            type: "boolean",
            description: "For domain or anyone: whether it appears in search rather than needing the link. Defaults to false.",
          },
          sendNotificationEmail: {
            type: "boolean",
            description: "Email a user or group that it was shared. Defaults to false; Drive requires it for a non-Google address.",
          },
          emailMessage: {
            type: "string",
            maxLength: 2000,
            description: "Message in the notification email; only with sendNotificationEmail true.",
          },
        },
        ["fileId", "type", "role"],
      ),
      outputSchema: PERMISSION_SCHEMA,
      handler: async (args, ctx) => {
        const type = String(args["type"]);
        const person = type === "user" || type === "group";
        const refuse = (message: string): never => {
          throw new ConnectorCallError("invalid_args", message);
        };
        if (person !== (args["emailAddress"] !== undefined)) refuse("emailAddress goes with type user or group, and only with them.");
        if ((type === "domain") !== (args["domain"] !== undefined)) refuse("domain goes with type domain, and only with it.");
        if (person && args["allowFileDiscovery"] !== undefined) refuse("allowFileDiscovery applies to type domain or anyone only.");
        if (!person && args["sendNotificationEmail"] !== undefined) refuse("sendNotificationEmail applies to a user or group only.");
        const notify = person ? args["sendNotificationEmail"] === true : undefined;
        if (args["emailMessage"] !== undefined && notify !== true) refuse("emailMessage needs sendNotificationEmail true.");
        return projectPermission(
          await adding(() => client.json(
            {
              method: "POST",
              path: `${filePath(args["fileId"])}/permissions`,
              query: {
                ...ALL_DRIVES,
                fields: PERMISSION_FIELDS,
                // Drive's default is to email; this connection's is not to.
                sendNotificationEmail: notify,
                emailMessage: args["emailMessage"],
              },
              body: compact({
                type,
                role: args["role"],
                emailAddress: args["emailAddress"],
                domain: args["domain"],
                allowFileDiscovery: person ? undefined : args["allowFileDiscovery"] === true,
              }),
            },
            ctx,
          ), "Check list_permissions before sharing again: the share may already be in place, and its notification sent."),
        );
      },
    },
    {
      name: "update_permission",
      description:
        "Change the role of one existing share on a Drive file or folder. Never makes anyone an owner; an inherited share is changed on the folder it comes from.",
      annotations: destructive,
      inputSchema: input({ fileId: FILE_ID, permissionId: PERMISSION_ID, role: ROLE_PROPERTY }, [
        "fileId",
        "permissionId",
        "role",
      ]),
      outputSchema: PERMISSION_SCHEMA,
      handler: async (args, ctx) =>
        projectPermission(
          await client.json(
            {
              method: "PATCH",
              path: `${filePath(args["fileId"])}/permissions/${encodeURIComponent(args["permissionId"])}`,
              query: { ...ALL_DRIVES, fields: PERMISSION_FIELDS },
              body: { role: args["role"] },
            },
            ctx,
            IDEMPOTENT,
          ),
          String(args["permissionId"]),
        ),
    },
    {
      name: "delete_permission",
      description:
        "Remove one share from a Drive file or folder, revoking that user's, group's, domain's, or link's access. Never deletes the file; an owner cannot be removed.",
      annotations: destructive,
      inputSchema: input({ fileId: FILE_ID, permissionId: PERMISSION_ID }, ["fileId", "permissionId"]),
      outputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string" },
          permissionId: { type: "string" },
          deleted: { type: "boolean", const: true },
        },
        required: ["fileId", "permissionId", "deleted"],
      },
      handler: async (args, ctx) => {
        await client.json(
          {
            method: "DELETE",
            path: `${filePath(args["fileId"])}/permissions/${encodeURIComponent(args["permissionId"])}`,
            query: ALL_DRIVES,
          },
          ctx,
        );
        return { fileId: args["fileId"], permissionId: args["permissionId"], deleted: true };
      },
    },
  ];
}

/**
 * The last word on size, around every tool and every way it can return:
 * whatever a handler built, a result past the call's `maxBytes` — or the
 * shared budget, for a tool without one — is refused rather than delivered.
 * Each source is budgeted where it is built, so this should never fire; when
 * it does, the caller learns why instead of a result execute_code cannot
 * receive.
 *
 * A write handler returns only from Google's recorded 2xx to its write — the
 * shared client throws on every other status, a redirect included, and on a
 * reply it could not read — so a write that gets here has applied, and only
 * here does this connection say so, pointing at a re-read rather than a
 * repeat.
 */
function guarded(list: ApiTool[]): ApiTool[] {
  return list.map((tool) => ({
    ...tool,
    handler: async (args: JsonRecord, ctx: ApiHandlerContext) => {
      const result = await tool.handler(args, ctx);
      const budget = typeof args?.["maxBytes"] === "number" ? args["maxBytes"] : DEFAULT_RESULT_BYTES;
      const bytes = jsonBytes(result);
      if (bytes <= budget) return result;
      const raisable = asRecord(asRecord(tool.inputSchema)["properties"])["maxBytes"] !== undefined;
      throw new ConnectorCallError(
        "connector_call_failed",
        tool.annotations.readOnlyHint
          ? `This ${tool.name} result serializes to ${bytes} bytes, past ${raisable ? `this call's maxBytes of ${budget}` : `the ${budget} bytes one result may carry`}; nothing is returned. ${raisable ? `Raise maxBytes (up to ${MAX_RESULT_BYTES}, for a direct call_tool only), or narrow the request.` : "Read the item in Drive instead."}`
          : `${tool.name} applied, but its result serializes to ${bytes} bytes, past the ${budget} bytes one result may carry, so it is not returned. Re-read the item with get_file; do not repeat the write.`,
        { retryable: false },
      );
    },
  }));
}

// --- Guide ------------------------------------------------------------------------

function usageGuide(purpose: string, instructions: string | undefined): string {
  const extra = instructions?.trim();
  return `${skill.fragments.guide_0}${purpose}${skill.fragments.guide_1}${extra ? `\n## ${skill.instructionsHeading}\n\n${extra}\n` : ""}`;
}

// --- Construction -----------------------------------------------------------------

/**
 * A maintained Google Drive connection acting as each signed-in Workspace
 * user through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Drive API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches users' files.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new (or edit
 *    the client's existing entry, adding to its scopes). Paste the client ID
 *    and exactly this scope ({@link DRIVE_SCOPES}):
 *    `https://www.googleapis.com/auth/drive`.
 *    A new grant can take up to 24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * drive("files", {
 *   purpose: "Staff documents and shared drives",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * The `drive` scope reaches everything the user can; the tool surface is what
 * keeps this connection from deleting a file permanently or transferring
 * ownership. Every write crosses host approval through call_destructive_tool
 * or a trusted program.
 */
export const drive = asProviderFactory<DriveOptions>({
  name: "drive",
  title: "Google Drive",
  kind: "api",
  readme: "Google Drive",
  bundle: {"baselineGzip":28955,"maxGzip":88955,"note":"./providers/drive starts at 28,955 B gzip (#680): the same class as ./providers/gmail — a hand-written api() surface over the shared Workspace delegation layer, with two confined transports (API and upload host) and no MCP SDK. The cap uses the existing baseline + 60,000 B policy."},
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  create: driveConnector,
});

function driveConnector(id: string, options: DriveOptions): Connector {
  const connection = workspaceConnection("drive", options);
  const baseUrl = options.baseUrl?.trim() || DRIVE_API_BASE_URL;
  const shared = {
    provider: "Google Drive",
    api: "Google Drive API",
    scopes: DRIVE_SCOPES,
    maxResponseBytes: DRIVE_MAX_RESPONSE_BYTES,
    // Drive answers 404 for a file that exists but is not shared with this
    // account, exactly as for one that does not exist.
    notFound: "ambiguous",
    connection,
  } as const;
  const client = googleWorkspaceClient({ ...shared, baseUrl });
  const upload = googleWorkspaceClient({ ...shared, baseUrl: uploadBaseUrl(baseUrl) });
  return api(id, {
    ...defined({
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
    title: options.title ?? "Google Drive",
    description: `Google Drive as the signed-in Workspace user: search, read, write, and share files, never delete them for good — ${connection.purpose}`,
    usageGuide: {
      content: usageGuide(connection.purpose, options.instructions),
      summary: "Each caller's own Drive: query syntax, Docs as Markdown, capped content, recoverable trash, quiet sharing.",
      // Required: whose Drive it is, the first-sheet CSV, and what
      // update_file_content replaces are conventions no schema can carry.
      required: true,
    },
    tools: guarded(tools(client, upload)),
  });
}
