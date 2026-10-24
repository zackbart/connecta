// Google Drive named workflows, bounded projections and bound continuation on the provider kit.
import { Effect, Option, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { toConnectorCallError, type HttpFailure } from "../../http/errors.js";
import { Classification, Dispatches, Signal, type CallServices } from "../../http/services.js";
import type { Connection } from "../../http/vendor.js";
import type { ConnectorContext } from "../../types.js";
import { RESULT_BUDGET_BYTES, clampText, jsonBytes } from "../_shared/google/result-size.js";
import { googleOutcomeOf, googleFailureMessage } from "../_shared/google/kit.js";
import { read, write } from "../../http/tools.js";
import { fieldsInput, fieldsProblem, selectFields } from "../../http/fields.js";
import { catalogSchema } from "../../http/json-schema.js";
import { Refusal } from "../../http/errors.js";
import { Operation } from "../../runtime/call.js";
import { boundCursor } from "../../http/paging.js";
import { refuseWithheldValues, refuseWithheldLinks } from "../_shared/rest/value-safety.js";
import * as contracts from "./lib/contracts.js";
import { driveClient, driveUploadConnection, type DriveClient } from "./api.js";
import type { DriveOptions } from "./index.js";
import { encodeForAgent, redactBeforeCut, redactBoundedRead, redactSentSecrets } from "../../sent-secrets.js";
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
 * result stash (8 MiB by default) still pages through connecta.result; execute_code
 * cannot receive that much.
 */
const DEFAULT_RESULT_BYTES = RESULT_BUDGET_BYTES;
/** Maximum whole-result budget for a direct call. */
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
/**
 * Strings Drive does not bound for us, cut in JSON bytes so one row or one
 * file always fits under the smallest `maxBytes`: a name in a listing, a
 * write result, or a content result; a name and description in get_file; and
 * labels such as a display name. A cut string ends with "…" and its field is
 * named in the result's `truncated`, so a real ellipsis is never taken
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
 * The longest inner cursor; its signed outer envelope has a 32 KiB input cap.
 * Drive's page tokens are a few hundred characters; one so long that a cursor
 * carrying it would pass this is refused when Drive sends it, rather than
 * issued and then refused on replay.
 */
const MAX_CURSOR_CHARS = 16_384;
const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const NATIVE = "application/vnd.google-apps.";
/** Google file types the content tool exports, and as what. */
const EXPORTS: Readonly<
  Record<
    string,
    {
      mimeType: string;
      format: ContentFormat;
      note?: string;
    }
  >
> = {
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
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
/** Drive reports sizes as int64 strings. */
function sizeOf(ctx: ConnectorContext, value: unknown): number | undefined {
  if (redactBeforeCut(ctx, value) !== value) return undefined;
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
  constructor(private readonly ctx: ConnectorContext) {}
  /** A string Drive does not bound, cut to `bytes` of JSON with "…". */
  label(field: string, value: unknown, bytes = LABEL_BYTES): string | undefined {
    const whole = typeof value === "string" ? value : undefined;
    if (whole === undefined || (whole === "" && field !== "name")) return undefined;
    const kept = clampText(this.ctx, whole, bytes, () => "…");
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
    if (kept.length !== all.length || kept.length > MAX_LISTED_IDS) this.cut.add(`${field}[]`);
    return kept.length > 0 ? kept.slice(0, MAX_LISTED_IDS) : undefined;
  }
  /** Up to ten labels, each cut as {@link label} cuts one. */
  labels(field: string, values: unknown[]): string[] | undefined {
    const present = values.filter((value): value is string => typeof value === "string" && value !== "");
    if (present.length > MAX_LISTED_IDS) this.cut.add(`${field}[]`);
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
 * left out become `truncated` paths at the result boundary.
 */
function projectFile(
  ctx: ConnectorContext,
  value: unknown,
  fallbackId?: string,
  nameBytes = ROW_NAME_BYTES,
  extra?: (file: JsonRecord, cuts: Cuts) => JsonRecord,
): JsonRecord {
  const file = asRecord(value);
  const shortcut = asRecord(file["shortcutDetails"]);
  const cuts = new Cuts(ctx);
  const projected = compact({
    id: cuts.id("id", file["id"]) ?? fallbackId,
    name: cuts.label("name", file["name"], nameBytes),
    mimeType: cuts.label("mimeType", file["mimeType"]),
    parents: cuts.ids("parents", file["parents"]),
    driveId: cuts.id("driveId", file["driveId"]),
    size: sizeOf(ctx, file["size"]),
    modifiedTime: cuts.label("modifiedTime", file["modifiedTime"]),
    owners: cuts.labels(
      "owners",
      asArray(file["owners"]).map((owner) => asRecord(owner)["emailAddress"]),
    ),
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
function projectFileDetail(ctx: ConnectorContext, value: unknown, fallbackId: string): JsonRecord {
  return projectFile(ctx, value, fallbackId, DETAIL_NAME_BYTES, (file, cuts) => {
    const modifier = asRecord(file["lastModifyingUser"]);
    const granted = asRecord(file["capabilities"]);
    const capabilities = compact(Object.fromEntries(CAPABILITIES.map((name) => [name, bool(granted[name])])));
    return {
      description: cuts.label("description", file["description"], DETAIL_DESCRIPTION_BYTES),
      createdTime: cuts.label("createdTime", file["createdTime"]),
      modifiedBy:
        cuts.label("modifiedBy", text(modifier["emailAddress"])) ??
        cuts.label("modifiedBy", text(modifier["displayName"])),
      shared: bool(file["shared"]),
      starred: bool(file["starred"]),
      capabilities: Object.keys(capabilities).length > 0 ? capabilities : undefined,
    };
  });
}
function projectPermission(ctx: ConnectorContext, value: unknown, fallbackId?: string): JsonRecord {
  const permission = asRecord(value);
  const details = asArray(permission["permissionDetails"]).map(asRecord);
  const cuts = new Cuts(ctx);
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
function cursorText(resume: Resume): string {
  const { token, skip, size, scope, page, last } = resume;
  return JSON.stringify([token, skip, size, scope, page, last]);
}
/**
 * The cursor an agent pages with. Drive's page token is the only downstream
 * text in it, and it arrives redacted ({@link pageOf}); the rest is
 * connecta's counts and fingerprints.
 */
function encodeCursor(ctx: ConnectorContext, resume: Resume): string {
  return encodeForAgent(ctx, cursorText(resume), { url: true, claims: true });
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
      Number.isSafeInteger(skip) &&
      (skip as number) >= 0 &&
      Number.isSafeInteger(size) &&
      (size as number) >= 1 &&
      (size as number) <= MAX_PAGE_SIZE &&
      typeof scope === "string" &&
      FINGERPRINT.test(scope) &&
      // A cursor inside a page proves which page; one at a boundary has nothing to prove.
      ((skip as number) > 0 ? midPage : page === null && last === null)
    ) {
      refuseWithheldValues(token, "Drive continuation", true);
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
  const text = cursorText({
    token,
    skip: MAX_PAGE_SIZE,
    size: MAX_PAGE_SIZE,
    scope: widest,
    page: widest,
    last: widest,
  });
  return Math.ceil((encoder.encode(text).length * 4) / 3) <= MAX_CURSOR_CHARS;
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
 */
function pageOf(
  ctx: ConnectorContext,
  key: string,
  args: JsonRecord,
  /** The tool and every argument that decides which rows, in which order. */
  binding: JsonRecord,
  fetch: (token: string | undefined, size: number) => Effect.Effect<Fetched, HttpFailure, CallServices>,
): Effect.Effect<JsonRecord, HttpFailure, CallServices> {
  return Effect.gen(function* () {
    const maxBytes: number = (args["maxBytes"] ?? DEFAULT_RESULT_BYTES) - 8192;
    const size: number = args["limit"] ?? DEFAULT_PAGE_SIZE;
    const scope = yield* Effect.promise(() => fingerprint({ ...binding, size }));
    const resume: Resume =
      typeof args["cursor"] === "string"
        ? decodeCursor(args["cursor"])
        : { token: null, skip: 0, size, scope, page: null, last: null };
    if (resume.scope !== scope) {
      throw new ConnectorCallError(
        "invalid_args",
        "This cursor belongs to a different listing — another tool, or other arguments. Pass the same arguments it was issued with, or omit cursor to start over.",
      );
    }
    const fetched = yield* fetch(resume.token ?? undefined, resume.size);
    // Drive's token goes into a cursor the agent decodes, which no later pass reads through:
    // it is redacted first, so a token echoing a sent value cannot carry it.
    if (fetched.next !== undefined) fetched.next = redactSentSecrets(ctx, fetched.next);
    if (fetched.next !== undefined && !issuable(fetched.next)) {
      throw new ConnectorCallError(
        "connector_call_failed",
        `Drive answered with a next-page token of ${fetched.next.length} characters, too long for a cursor this connection can accept back (${MAX_CURSOR_CHARS}), so the listing cannot be resumed past this page. Narrow the query, or raise limit to take more per page.`,
        { retryable: false },
      );
    }
    // Drive's ids as Drive sent them, so two that differ anywhere differ here.
    const page = yield* Effect.promise(() => fingerprint(fetched.ids));
    const lasts = yield* Effect.promise(() => Promise.all(fetched.ids.map((id) => fingerprint(id))));
    if (resume.skip > 0 && (page !== resume.page || lasts[resume.skip - 1] !== resume.last)) {
      throw new ConnectorCallError(
        "conflict",
        `The Drive page this cursor resumes inside has changed since it was read — ${key} were added, removed, or reordered — so resuming by position could skip or repeat some. Nothing was returned; start the listing again without cursor.`,
        { retryable: false },
      );
    }
    const rows = fetched.rows.slice(resume.skip);
    const build = (count: number): JsonRecord => {
      const nextCursor =
        count < rows.length
          ? encodeCursor(ctx, {
              ...resume,
              skip: resume.skip + count,
              page,
              last: lasts[resume.skip + count - 1] ?? "",
            })
          : fetched.next
            ? encodeCursor(ctx, { token: fetched.next, skip: 0, size: resume.size, scope, page: null, last: null })
            : null;
      return {
        items: rows.slice(0, count),
        ...fetched.extra,
        page: { hasMore: nextCursor !== null, ...(nextCursor ? { nextCursor } : {}) },
      };
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
  });
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
  return type.startsWith("text/") || TEXT_TYPES.has(type) || type.endsWith("+json") || type.endsWith("+xml");
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
function codePointCut(
  value: string,
  max: number,
): {
  end: number;
  total: number;
} {
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
  ctx: ConnectorContext,
  whole: string,
  max: number,
  partial:
    | {
        size: number | undefined;
      }
    | undefined,
  fits: (content: string) => boolean,
): {
  content: string;
  contentTruncated: boolean;
} {
  if (codePointCut(whole, max).total <= max && !partial && fits(whole))
    return { content: whole, contentTruncated: false };
  // Every secret the request sent is replaced before the cut, which could otherwise split one.
  const body = redactBeforeCut(ctx, whole);
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
function download(
  client: DriveClient,
  ctx: ConnectorContext,
  path: string,
  limit: number,
): Effect.Effect<
  {
    bytes: Uint8Array;
    more: boolean;
    contentType: string | undefined;
  },
  HttpFailure,
  CallServices
> {
  return Effect.gen(function* () {
    const read = yield* client.bytes(
      {
        method: "GET",
        path,
        query: { ...ALL_DRIVES, alt: "media" },
        headers: { Range: `bytes=0-${limit}` },
      },
      "*/*",
      { maxBytes: limit, step: "content" },
    );
    return { bytes: read.bytes.subarray(0, limit), more: read.truncated, contentType: read.contentType };
  });
}
function readContent(
  client: DriveClient,
  ctx: ConnectorContext,
  fileId: string,
  maxChars: number,
  maxBytes: number,
): Effect.Effect<JsonRecord, HttpFailure, CallServices> {
  return Effect.gen(function* () {
    const filePath = `/files/${encodeURIComponent(fileId)}`;
    const file = decisionRecord(
      yield* client.json(
        {
          method: "GET",
          path: filePath,
          query: {
            ...ALL_DRIVES,
            fields:
              "id,name,mimeType,size,webViewLink,capabilities(canDownload),shortcutDetails(targetId,targetMimeType)",
          },
        },
        { step: "metadata" },
      ),
    );
    decisionInputs(file, ["mimeType", "shortcutDetails", "capabilities"]);
    const mimeType = String(file["mimeType"] ?? "application/octet-stream");
    const size = sizeOf(ctx, file["size"]);
    const cuts = new Cuts(ctx);
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
      const { text: body } = yield* client.text(
        { method: "GET", path: `${filePath}/export`, query: { mimeType: exported.mimeType } },
        exported.mimeType,
        { step: "content" },
      );
      const result = compact({
        ...base,
        format: exported.format,
        exportedAs: exported.mimeType,
        content: "",
        contentTruncated: false,
        note: exported.note,
      });
      return { ...result, ...capped(ctx, body, maxChars, undefined, within(result)) };
    }
    if (isText(mimeType)) {
      const read = yield* download(client, ctx, filePath, textBudget(maxChars));
      let body = decodeIn(read.bytes, read.contentType);
      // A cut can land inside a character; drop the half, never show it. A sent
      // secret the read stopped inside never arrives whole, so its start goes too.
      if (read.more) body = redactBoundedRead(ctx, body.replace(/(?:\uFFFD|[\uD800-\uDBFF])$/, ""));
      const result = { ...base, format: "text", content: "", contentTruncated: false };
      return { ...result, ...capped(ctx, body, maxChars, read.more ? { size } : undefined, within(result)) };
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
    const read = yield* download(client, ctx, filePath, limit);
    if (read.more) return tooLarge(`more than ${limit} bytes`);
    return { ...base, format: "base64", content: encodeForAgent(ctx, read.bytes), contentTruncated: false };
  });
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
function adding<T>(connection: Connection, work: () => Effect.Effect<T, HttpFailure, CallServices>, check: string) {
  return Effect.suspend(work).pipe(
    Effect.catch((failure) =>
      Effect.gen(function* () {
        const outcome = googleOutcomeOf(failure);
        if (
          !outcome?.dispatched ||
          outcome.phase === "refused" ||
          outcome.phase === "before-send" ||
          outcome.phase === "unauthorized"
        )
          return yield* Effect.fail(failure);
        const error = toConnectorCallError(failure, connection.errors, {
          classification: yield* Classification,
          dispatches: yield* Dispatches,
          withholds: connection.safety.withholdsErrors,
          signal: yield* Signal,
        });
        if (error.code === "connector_call_failed")
          return yield* googleFailureMessage(connection, failure, (message) => message + " " + check);
        return yield* Effect.fail(failure);
      }),
    ),
  );
}
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
function media(args: JsonRecord):
  | {
      bytes: Uint8Array;
      type: string;
    }
  | undefined {
  const hasText = typeof args["content"] === "string";
  const hasBinary = typeof args["contentBase64"] === "string";
  if (hasText && hasBinary) {
    throw new ConnectorCallError("invalid_args", "Pass content or contentBase64, not both.");
  }
  if (hasText) {
    refuseWithheldValues(args["content"], "Drive text upload");
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
    refuseWithheldValues(new TextDecoder().decode(bytes), "Drive binary upload");
    refuseWithheldLinks(new TextDecoder().decode(bytes), "Drive binary upload");
    return { bytes, type: mediaType(args["mimeType"], "application/octet-stream") };
  }
  return undefined;
}
/**
 * One `multipart/related` body: the metadata as JSON, then the media. Built
 * whole as bytes, never a stream: GoogleRequest.rawBody admits only strings
 * and byte arrays. An upload is a write and is never resent.
 */
function multipart(
  metadata: JsonRecord,
  content: {
    bytes: Uint8Array;
    type: string;
  },
): {
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
// --- Tools ------------------------------------------------------------------------
export function driveTools({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<DriveOptions>;
}): ApiTool[] {
  const client = driveClient(connection);
  const uploadConnection = driveUploadConnection(options);
  const upload = driveClient(uploadConnection);
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
    step?: string,
  ) =>
    // The Drive query decides the rows: folder, search, corpus, drive, order.
    pageOf(ctx, "files", args, { tool, ...query }, (pageToken, pageSize) =>
      Effect.gen(function* () {
        const listing = asRecord(
          yield* client.json(
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
            step ? { step } : undefined,
          ),
        );
        return {
          ids: asArray(listing["files"]).map((file) => String(asRecord(file)["id"] ?? "")),
          rows: asArray(listing["files"]).map((file) => projectFile(ctx, file)),
          next: nextToken(listing["nextPageToken"]),
          // Drive's own truncation: it stopped before searching every corpus.
          extra: listing["incompleteSearch"] === true ? { incompleteSearch: true } : undefined,
        };
      }),
    );
  const patch = (
    ctx: ConnectorContext,
    fileId: string,
    body: JsonRecord,
    query: Record<string, string | undefined> = {},
  ) =>
    Effect.gen(function* () {
      return projectFile(
        ctx,
        yield* client.json({
          method: "PATCH",
          path: filePath(fileId),
          query: { ...ALL_DRIVES, fields: SUMMARY_FIELDS, ...query },
          body,
        }),
        fileId,
      );
    });
  const declarations: DriveTool[] = [
    {
      name: "search_files",
      description:
        "Search Drive files the user can open with Drive query syntax, returning name, type, folder, size, and link per file. Content needs get_file_content.",
      annotations: readOnly,
      contract: contracts.search_files,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const corpora = args["corpora"] ?? "user";
          if ((corpora === "drive") !== (args["driveId"] !== undefined)) {
            throw new ConnectorCallError(
              "invalid_args",
              "driveId goes with corpora drive and only with it; find shared drive ids with list_shared_drives.",
            );
          }
          const query = text(args["query"]);
          const q =
            args["includeTrashed"] === true ? query : query ? `(${query}) and trashed = false` : "trashed = false";
          return yield* list(ctx, "search_files", args, {
            q,
            corpora,
            driveId: args["driveId"],
            orderBy: args["orderBy"],
          });
        }),
    },
    {
      name: "list_folder_items",
      writeSteps: { folder: "once", files: "once" },
      description:
        "List the files and folders directly inside one Drive folder, in My Drive or a shared drive. Not recursive: list a subfolder by its own id.",
      annotations: readOnly,
      contract: contracts.list_folder_items,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const folderId = String(args["folderId"]);
          // A shared drive folder is listed within its drive, which Drive
          // searches only when asked by id; the folder itself says which.
          let driveId: string | undefined;
          if (folderId !== "root") {
            const folder = decisionRecord(
              yield* client.json(
                {
                  method: "GET",
                  path: filePath(folderId),
                  query: { ...ALL_DRIVES, fields: "id,mimeType,driveId" },
                },
                { step: "folder" },
              ),
            );
            decisionInputs(folder, ["mimeType", "driveId"]);
            if (folder["mimeType"] !== FOLDER) {
              throw new ConnectorCallError(
                "invalid_args",
                `${folderId} is not a folder (${String(folder["mimeType"] ?? "unknown type")}); read it with get_file or get_file_content.`,
              );
            }
            driveId = text(folder["driveId"]);
          }
          const q = `'${folderId}' in parents${args["includeTrashed"] === true ? "" : " and trashed = false"}`;
          return yield* list(
            ctx,
            "list_folder_items",
            args,
            {
              q,
              corpora: driveId ? "drive" : "user",
              driveId,
              orderBy: args["orderBy"] ?? "folder,name",
            },
            "files",
          );
        }),
    },
    {
      name: "get_file",
      description:
        "Get one Drive file's metadata: name, type, folder, owners, sharing flag, description, and what this user may do with it. Never its content.",
      annotations: readOnly,
      contract: contracts.get_file,
      run: (args, ctx) =>
        Effect.gen(function* () {
          return projectFileDetail(
            ctx,
            yield* client.json({
              method: "GET",
              path: filePath(args["fileId"]),
              query: { ...ALL_DRIVES, fields: DETAIL_FIELDS },
            }),
            String(args["fileId"]),
          );
        }),
    },
    {
      name: "get_file_content",
      writeSteps: { metadata: "once", content: "once" },
      description:
        "Read a Drive file's content: Docs as Markdown, Sheets as CSV of the first sheet, Slides as text, text files as text, small binaries as base64. Never drawings or folders.",
      annotations: readOnly,
      contract: contracts.get_file_content,
      run: (args, ctx) =>
        Effect.gen(function* () {
          return yield* readContent(
            client,
            ctx,
            String(args["fileId"]),
            typeof args["maxChars"] === "number" ? args["maxChars"] : DEFAULT_CONTENT_CHARS,
            typeof args["maxBytes"] === "number" ? args["maxBytes"] : DEFAULT_RESULT_BYTES,
          );
        }),
    },
    {
      name: "list_permissions",
      description:
        "List who a Drive file or folder is shared with: each permission's id, type, role, and address or domain. Use the ids with update_permission or delete_permission.",
      annotations: readOnly,
      contract: contracts.list_permissions,
      run: (args, ctx) =>
        Effect.gen(function* () {
          return yield* pageOf(
            ctx,
            "permissions",
            args,
            { tool: "list_permissions", fileId: args["fileId"] },
            (pageToken, pageSize) =>
              Effect.gen(function* () {
                const listing = asRecord(
                  yield* client.json({
                    method: "GET",
                    path: `${filePath(args["fileId"])}/permissions`,
                    query: {
                      ...ALL_DRIVES,
                      fields: `nextPageToken,permissions(${PERMISSION_FIELDS})`,
                      pageSize,
                      pageToken,
                    },
                  }),
                );
                return {
                  ids: asArray(listing["permissions"]).map((permission) => String(asRecord(permission)["id"] ?? "")),
                  rows: asArray(listing["permissions"]).map((permission) => projectPermission(ctx, permission)),
                  next: nextToken(listing["nextPageToken"]),
                };
              }),
          );
        }),
    },
    {
      name: "list_shared_drives",
      description:
        "List the shared drives the user is a member of, with their ids for search_files and list_folder_items. Not the files inside them.",
      annotations: readOnly,
      contract: contracts.list_shared_drives,
      run: (args, ctx) =>
        Effect.gen(function* () {
          return yield* pageOf(
            ctx,
            "drives",
            args,
            { tool: "list_shared_drives", q: args["query"] },
            (pageToken, pageSize) =>
              Effect.gen(function* () {
                const listing = asRecord(
                  yield* client.json({
                    method: "GET",
                    path: "/drives",
                    query: {
                      q: args["query"],
                      fields: "nextPageToken,drives(id,name,hidden)",
                      pageSize,
                      pageToken,
                    },
                  }),
                );
                return {
                  ids: asArray(listing["drives"]).map((value) => String(asRecord(value)["id"] ?? "")),
                  rows: asArray(listing["drives"]).map((value) => {
                    const sharedDrive = asRecord(value);
                    const cuts = new Cuts(ctx);
                    return compact({
                      id: cuts.id("id", sharedDrive["id"]),
                      name: cuts.label("name", sharedDrive["name"]),
                      hidden: sharedDrive["hidden"] === true ? true : undefined,
                      truncatedFields: cuts.fields,
                    });
                  }),
                  next: nextToken(listing["nextPageToken"]),
                };
              }),
          );
        }),
    },
    {
      name: "create_folder",
      description:
        "Create a new, empty Drive folder, in My Drive or inside another folder. Shares nothing beyond what the parent folder already grants.",
      annotations: additive,
      contract: contracts.create_folder,
      run: (args, ctx) =>
        Effect.gen(function* () {
          return projectFile(
            ctx,
            yield* adding(
              connection,
              () =>
                client.json({
                  method: "POST",
                  path: "/files",
                  query: { ...ALL_DRIVES, fields: SUMMARY_FIELDS },
                  body: compact({
                    name: args["name"],
                    mimeType: FOLDER,
                    parents: args["parentId"] ? [args["parentId"]] : undefined,
                    description: args["description"],
                  }),
                }),
              CHECK_CREATED,
            ),
          );
        }),
    },
    {
      name: "create_file",
      description:
        "Create a Drive file from text or base64 content, or an empty one; convertTo makes a Google Doc, Sheet, or Slides file. Whoever can see its folder can see it.",
      // Destructive though nothing is overwritten: a new file takes its
      // folder's sharing, so content written into a shared folder is
      // disclosed to everyone it is shared with, at once.
      annotations: destructive,
      contract: contracts.create_file,
      run: (args, ctx) =>
        Effect.gen(function* () {
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
              throw new ConnectorCallError(
                "invalid_args",
                "mimeType describes content; pass content or contentBase64 with it.",
              );
            }
            return projectFile(
              ctx,
              yield* adding(
                connection,
                () =>
                  client.json({
                    method: "POST",
                    path: "/files",
                    query: { ...ALL_DRIVES, fields: SUMMARY_FIELDS },
                    body: metadata,
                  }),
                CHECK_CREATED,
              ),
            );
          }
          const framed = multipart(metadata, content);
          return projectFile(
            ctx,
            yield* adding(
              uploadConnection,
              () =>
                upload.json({
                  method: "POST",
                  path: "/files",
                  query: { ...ALL_DRIVES, uploadType: "multipart", fields: SUMMARY_FIELDS },
                  headers: { "Content-Type": framed.contentType },
                  rawBody: new Uint8Array(framed.body),
                }),
              CHECK_CREATED,
            ),
          );
        }),
    },
    {
      name: "update_file_content",
      description:
        "Replace a Drive file's entire content with new text or base64 bytes; the old content survives only in Drive's version history. Keeps name, folder, and sharing.",
      // Destructive: the whole content is overwritten. Drive keeps revisions
      // for a while, but this connection offers no way back to one.
      annotations: destructive,
      contract: contracts.update_file_content,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const content = media(args);
          if (!content) {
            throw new ConnectorCallError("invalid_args", "Pass content or contentBase64: the file's new content.");
          }
          return projectFile(
            ctx,
            yield* upload.json({
              method: "PATCH",
              path: filePath(args["fileId"]),
              query: { ...ALL_DRIVES, uploadType: "media", fields: SUMMARY_FIELDS },
              headers: { "Content-Type": content.type },
              rawBody: new Uint8Array(content.bytes),
            }),
            String(args["fileId"]),
          );
        }),
    },
    {
      name: "update_file",
      description:
        "Rename a Drive file or folder, or replace its description. Never its content, folder, or sharing: use update_file_content, move_file, or share_file.",
      // Destructive: the old name or description is overwritten, and a
      // rename can break what finds the file by name.
      annotations: destructive,
      contract: contracts.update_file,
      run: (args, ctx) =>
        Effect.gen(function* () {
          if (args["name"] === undefined && args["description"] === undefined) {
            throw new ConnectorCallError("invalid_args", "Pass name, description, or both.");
          }
          return yield* patch(ctx, args["fileId"], compact({ name: args["name"], description: args["description"] }));
        }),
    },
    {
      name: "move_file",
      writeSteps: { parents: "once", write: "once" },
      description:
        "Move a Drive file or folder into another folder or shared drive, out of the folder it is in now. Can change who has access to it.",
      // Destructive: a file inherits sharing from its folder, so a move can
      // revoke access granted through the old folder or grant it through the
      // new one, and moving into a shared drive hands ownership to the drive.
      annotations: destructive,
      contract: contracts.move_file,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const current = decisionRecord(
            yield* client.json(
              { method: "GET", path: filePath(args["fileId"]), query: { ...ALL_DRIVES, fields: "parents" } },
              { step: "parents", effect: "read" },
            ),
          );
          decisionInputs(current, ["parents"]);
          const from = idsOf(current["parents"]).filter((id) => id !== args["folderId"]);
          return yield* patch(
            ctx,
            args["fileId"],
            {},
            {
              addParents: args["folderId"],
              removeParents: from.length > 0 ? from.join(",") : undefined,
            },
          );
        }),
    },
    {
      name: "copy_file",
      description:
        "Copy a Drive file into a new file, optionally renamed or in another folder. The copy is shared like its folder, not like the original; no folders.",
      // Destructive though nothing is overwritten: the copy takes its
      // destination folder's sharing, so a private file copied into a shared
      // folder is disclosed — the same exposure move_file carries.
      annotations: destructive,
      contract: contracts.copy_file,
      run: (args, ctx) =>
        Effect.gen(function* () {
          return projectFile(
            ctx,
            yield* adding(
              connection,
              () =>
                client.json({
                  method: "POST",
                  path: `${filePath(args["fileId"])}/copy`,
                  query: { ...ALL_DRIVES, fields: SUMMARY_FIELDS },
                  body: compact({ name: args["name"], parents: args["parentId"] ? [args["parentId"]] : undefined }),
                }),
              "Look for the copy with search_files or list_folder_items before copying again: a second call makes a second copy.",
            ),
          );
        }),
    },
    {
      name: "trash_file",
      description:
        "Move a Drive file or folder to the trash, where Drive deletes it for good after 30 days; restore_file undoes it. Never deletes permanently itself.",
      // Destructive: collaborators lose the file at once, and the trash
      // empties itself.
      annotations: destructive,
      contract: contracts.trash_file,
      run: (args, ctx) =>
        Effect.gen(function* () {
          return yield* patch(ctx, args["fileId"], { trashed: true });
        }),
    },
    {
      name: "restore_file",
      description:
        "Restore (untrash) a trashed Drive file or folder to where it was. Cannot recover a file already deleted from the trash.",
      // Additive: brings back exactly what was there, losing nothing.
      annotations: additive,
      contract: contracts.restore_file,
      run: (args, ctx) =>
        Effect.gen(function* () {
          return yield* patch(ctx, args["fileId"], { trashed: false });
        }),
    },
    {
      name: "share_file",
      description:
        "Share a Drive file or folder with a user, group, domain, or anyone with the link, at a role up to writer. Sends no email unless asked; never transfers ownership.",
      annotations: destructive,
      contract: contracts.share_file,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const type = String(args["type"]);
          const person = type === "user" || type === "group";
          const refuse = (message: string): never => {
            throw new ConnectorCallError("invalid_args", message);
          };
          if (person !== (args["emailAddress"] !== undefined))
            refuse("emailAddress goes with type user or group, and only with them.");
          if ((type === "domain") !== (args["domain"] !== undefined))
            refuse("domain goes with type domain, and only with it.");
          if (person && args["allowFileDiscovery"] !== undefined)
            refuse("allowFileDiscovery applies to type domain or anyone only.");
          if (!person && args["sendNotificationEmail"] !== undefined)
            refuse("sendNotificationEmail applies to a user or group only.");
          const notify = person ? args["sendNotificationEmail"] === true : undefined;
          if (args["emailMessage"] !== undefined && notify !== true)
            refuse("emailMessage needs sendNotificationEmail true.");
          return projectPermission(
            ctx,
            yield* adding(
              connection,
              () =>
                client.json({
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
                }),
              "Check list_permissions before sharing again: the share may already be in place, and its notification sent.",
            ),
          );
        }),
    },
    {
      name: "update_permission",
      description:
        "Change the role of one existing share on a Drive file or folder. Never makes anyone an owner; an inherited share is changed on the folder it comes from.",
      annotations: destructive,
      contract: contracts.update_permission,
      run: (args, ctx) =>
        Effect.gen(function* () {
          return projectPermission(
            ctx,
            yield* client.json({
              method: "PATCH",
              path: `${filePath(args["fileId"])}/permissions/${encodeURIComponent(args["permissionId"])}`,
              query: { ...ALL_DRIVES, fields: PERMISSION_FIELDS },
              body: { role: args["role"] },
            }),
            String(args["permissionId"]),
          );
        }),
    },
    {
      name: "delete_permission",
      description:
        "Remove one share from a Drive file or folder, revoking that user's, group's, domain's, or link's access. Never deletes the file; an owner cannot be removed.",
      annotations: destructive,
      contract: contracts.delete_permission,
      run: (args) =>
        Effect.gen(function* () {
          yield* client.json({
            method: "DELETE",
            path: `${filePath(args["fileId"])}/permissions/${encodeURIComponent(args["permissionId"])}`,
            query: ALL_DRIVES,
          });
          return { fileId: args["fileId"], permissionId: args["permissionId"], deleted: true };
        }),
    },
  ];
  return declarations.map((declaration) => buildTool(connection, guarded(declaration)));
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
function guarded(tool: DriveTool): DriveTool {
  return {
    ...tool,
    run: (args: JsonRecord, ctx: ConnectorContext) =>
      Effect.gen(function* () {
        const result = standardResult(yield* tool.run(args, ctx));
        const budget = typeof args?.["maxBytes"] === "number" ? args["maxBytes"] : DEFAULT_RESULT_BYTES;
        const bytes = jsonBytes(result);
        if (bytes <= budget) return result;
        const raisable = "maxBytes" in tool.contract.input.fields;
        throw new ConnectorCallError(
          "connector_call_failed",
          tool.annotations.readOnlyHint
            ? `This ${tool.name} result serializes to ${bytes} bytes, past ${raisable ? `this call's maxBytes of ${budget}` : `the ${budget} bytes one result may carry`}; nothing is returned. ${raisable ? `Raise maxBytes (up to ${MAX_RESULT_BYTES}, for a direct call_tool only), or narrow the request.` : "Read the item in Drive instead."}`
            : `${tool.name} applied, but its result serializes to ${bytes} bytes, past the ${budget} bytes one result may carry, so it is not returned. Re-read the item with get_file; do not repeat the write.`,
          { retryable: false },
        );
      }),
  };
}

interface DriveTool {
  readonly name: keyof typeof contracts;
  readonly description: string;
  readonly annotations: { readonly readOnlyHint: boolean; readonly destructiveHint?: boolean };
  readonly contract: {
    readonly input: Schema.Struct<Schema.Struct.Fields> & { readonly DecodingServices: never };
    readonly output: Schema.Schema<any>;
  };
  readonly writeSteps?: Readonly<Record<string, "once">>;
  readonly run: (args: JsonRecord, ctx: ConnectorContext) => Effect.Effect<any, HttpFailure, CallServices>;
}
export function buildTool(connection: Connection, tool: DriveTool): ApiTool {
  const isRead = tool.annotations.readOnlyHint;
  const isList = ["search_files", "list_folder_items", "list_permissions", "list_shared_drives"].includes(tool.name);
  const output = asRecord(catalogSchema(tool.contract.output, "output"));
  const row = isList ? asRecord(asRecord(asRecord(output["properties"])["items"])["items"]) : output;
  const roots = new Set(Object.keys(asRecord(row["properties"])));
  const input = Schema.Struct({
    ...tool.contract.input.fields,
    ...(isRead
      ? {
          fields: Schema.optionalKey(
            fieldsInput(
              isList
                ? "Dot paths to keep in each item; only narrows the result."
                : "Dot paths to keep in the result; only narrows the result.",
            ),
          ),
        }
      : {}),
  }) as typeof tool.contract.input;
  const spec = {
    name: tool.name,
    description: tool.description,
    input,
    output: tool.contract.output,
    ...(tool.writeSteps ? { writeSteps: tool.writeSteps } : {}),
    run: (args: JsonRecord) =>
      Effect.gen(function* () {
        const fields = args["fields"] as string[] | undefined;
        const problem = isRead ? fieldsProblem(fields, roots, isList ? "an item" : "the result") : undefined;
        if (problem) return yield* Effect.fail(new Refusal({ error: problem }));
        const active = yield* Effect.serviceOption(Operation);
        const ctx = Option.isSome(active) ? active.value : undefined;
        if (!ctx) return yield* Effect.die(new Error(`${tool.name} needs a connector context.`));
        const supplied = args["cursor"] as string | undefined;
        const { maxBytes: _maxBytes, fields: _fields, ...cursorArgs } = args;
        const cursor = isList && supplied ? yield* boundCursor.decode(tool.name, cursorArgs, supplied) : supplied;
        const result = asRecord(yield* tool.run({ ...args, ...(cursor ? { cursor } : {}) }, ctx));
        const page = asRecord(result["page"]);
        if (isList && typeof page["nextCursor"] === "string")
          page["nextCursor"] = yield* boundCursor.encode(tool.name, cursorArgs, page["nextCursor"], (json) =>
            encodeForAgent(ctx, json, { url: true, claims: true }),
          );
        if (isList && jsonBytes(result) > (args["maxBytes"] ?? DEFAULT_RESULT_BYTES))
          throw new ConnectorCallError(
            "connector_call_failed",
            "Drive continuation exceeded the result byte budget; narrow the listing.",
          );
        return isRead
          ? isList
            ? {
                ...result,
                items: asArray(result["items"]).map((item) => retainTruncated(item, selectFields(item, fields))),
              }
            : retainTruncated(result, selectFields(result, fields))
          : result;
      }).pipe(
        Effect.catchDefect((error) =>
          error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
        ),
      ),
  };
  return isRead
    ? read(connection, spec)
    : write(connection, { ...spec, destructive: tool.annotations.destructiveHint !== false });
}

/** Field selection narrows data, while size provenance remains result metadata. */
function retainTruncated(source: unknown, selected: unknown): unknown {
  const truncated = asRecord(source)["truncated"];
  return truncated === undefined ? selected : { ...asRecord(selected), truncated };
}
/** Convert size reports before the final byte guard and field selection. */
function standardResult(value: unknown): any {
  const all = new Set<string>();
  const normalize = (value: unknown, path = ""): any => {
    if (Array.isArray(value)) return value.map((item) => normalize(item, `${path}[]`));
    if (!value || typeof value !== "object") return value;
    const out: JsonRecord = {};
    const cuts: string[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (key === "truncatedFields") cuts.push(...(item as string[]));
      else if (key === "contentTruncated") {
        if (item === true) cuts.push("content");
      } else out[key] = normalize(item, path ? `${path}.${key}` : key);
    }
    for (const cut of cuts) all.add(path ? `${path}.${cut}` : cut);
    if (cuts.length) out["truncated"] = [...new Set(cuts)];
    return out;
  };
  const result = normalize(value);
  if (all.size) result["truncated"] = [...all];
  return result;
}
function nextToken(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string")
    throw new ConnectorCallError("connector_call_failed", "Drive returned malformed continuation metadata.");
  return value;
}
function decisionRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) decisionFailure();
  // A withheld key may have been mimeType/parents; absence cannot then mean a legitimate omission.
  for (const key of Object.keys(value)) {
    try {
      refuseWithheldValues(key, "Drive decision metadata", true);
    } catch {
      decisionFailure();
    }
  }
  return value as JsonRecord;
}
function decisionFailure(): never {
  throw new ConnectorCallError(
    "connector_call_failed",
    "Drive decision metadata was withheld or malformed; no follow-up request was sent.",
    { retryable: false },
  );
}
/** Only safe response values are inspected; never recover the original decision inputs. */
function decisionInputs(file: JsonRecord, keys: readonly string[]): void {
  for (const key of keys) {
    const value = file[key];
    try {
      refuseWithheldValues(value, "Drive decision metadata", true);
    } catch {
      decisionFailure();
    }
    if (value === undefined) continue;
    if (key === "mimeType" && (typeof value !== "string" || !MEDIA_TYPE.test(value))) decisionFailure();
    if (key === "driveId" && (typeof value !== "string" || !DRIVE_ID.test(value))) decisionFailure();
    if (
      key === "parents" &&
      (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !DRIVE_ID.test(id)))
    )
      decisionFailure();
    if (
      key === "capabilities" &&
      (typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        (asRecord(value)["canDownload"] !== undefined && typeof asRecord(value)["canDownload"] !== "boolean"))
    )
      decisionFailure();
    if (key === "shortcutDetails") {
      const shortcut = decisionRecord(value);
      if (
        shortcut["targetId"] !== undefined &&
        (typeof shortcut["targetId"] !== "string" || !DRIVE_ID.test(shortcut["targetId"]))
      )
        decisionFailure();
      if (
        shortcut["targetMimeType"] !== undefined &&
        (typeof shortcut["targetMimeType"] !== "string" || !MEDIA_TYPE.test(shortcut["targetMimeType"]))
      )
        decisionFailure();
    }
  }
}
