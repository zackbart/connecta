// Google Slides named workflows on real kit schemas, with bound content continuation.
import { Effect, Option, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import type { HttpFailure } from "../../http/errors.js";
import type { CallServices } from "../../http/services.js";
import type { Connection } from "../../http/vendor.js";
import type { ConnectorContext } from "../../types.js";
import { RESULT_BUDGET_BYTES, clampRedactedText, clampText, jsonBytes } from "../_shared/google/result-size.js";
import { googleClient, googleOutcomeOf, googleFailureMessage, type GoogleClient } from "../_shared/google/kit.js";
import { encodeForAgent, redactBeforeCut, redactSentSecrets } from "../../sent-secrets.js";
import { REQUEST_KINDS, COMMENT_KINDS, COMMENTS_UNSAVED } from "./lib/requests.js";
import { SLIDES, SLIDES_INDEX } from "./api.js";
import * as contracts from "./lib/schemas.js";
import { read, write } from "../../http/tools.js";
import { Operation } from "../../runtime/call.js";
import { fieldsInput, fieldsProblem, selectFields } from "../../http/fields.js";
import { Refusal } from "../../http/errors.js";
import { boundCursor } from "../../http/paging.js";

/** Slides per page of get_presentation. Slides itself returns the whole deck. */
const DEFAULT_PAGE_SIZE = 20;
/** Elements per page of get_page, and rows per page of list_layouts. */
const MAX_ROWS = 500;
const DEFAULT_ELEMENTS = 50;
const DEFAULT_LAYOUTS = 100;
/** Text kept per slide (its elements together, and its notes apart). */
const DEFAULT_SLIDE_CHARS = 4_000;
/** Requests per raw batch: connecta's bound; Slides publishes none. */
/**
 * Every kind of Request Slides' batchUpdate accepts, from its Discovery
 * document's `Request` schema. The raw hatch checks each request's one key
 * against this list, and nothing inside it: an unknown kind is a typo or a
 * new kind to review here, and refusing it locally costs no round trip. The
 * contents are Slides' to validate. Too many names for a schema enum inside
 * the H7 budget, so the handler holds the list. A kind Google adds moves
 * the batchUpdate contract `src/providers/slides/drift.json` records.
 */
/** What get_presentation's first page may spend on its layout preview. */
const MAX_LAYOUT_PREVIEW_BYTES = 24 * 1024;
/** Byte bounds for short labels: names, titles, alt text. */
const MAX_NAME_BYTES = 256;
const MAX_TITLE_BYTES = 4 * 1024;
const MAX_ALT_TEXT_BYTES = 4 * 1024;
/** A slide title in get_presentation, in characters, before maxCharsPerSlide. */
const MAX_TITLE_CHARS = 500;
/** The longest thumbnail link passed on; a real one is well under 2 KB. */
const MAX_URL_BYTES = 16 * 1024;
/** One batchUpdate reply kept whole up to this; a larger one is summarized. */
const MAX_REPLY_BYTES = 2 * 1024;
/** How deep, and how many array items, a reply summary walks. */
const MAX_REPLY_DEPTH = 12;
const MAX_REPLY_ITEMS = 20;
/** An id or revision longer than this is not copied into a result. */
const MAX_ID_BYTES = 1024;
/** replace_all_text echoes each find this far, in order with its count. */
const MAX_ECHO_CHARS = 100;

/**
 * The comment kinds of Slides' Request. A batch carrying any of them has
 * comment changes Slides saves apart from the deck's, and only `ALL_SAVED`
 * says they all landed (#696).
 */

/** The comment save states that say every comment change in a batch landed, or none was asked for. */
const COMMENTS_SETTLED: ReadonlySet<string> = new Set(["NO_UPDATES_REQUESTED", "ALL_SAVED"]);

/**
 * `commentUpdateState`'s zero value. ProtoJSON omits a zero enum, so a batch
 * with comment requests whose reply has no state is reported as this one:
 * Slides did not say the comments saved.
 */
const COMMENT_STATE_UNSPECIFIED = "COMMENT_UPDATE_STATE_UNSPECIFIED";

/**
 * The only view mode that cannot hide comments silently. The default omits
 * them, and DEFAULT_FOR_CURRENT_ACCESS omits them for a view-only account,
 * which would read as a deck with none; INCLUDED refuses that account with a
 * 403 instead.
 */
const COMMENTS_INCLUDED = "COMMENTS_VIEW_MODE_INCLUDED";

/** Slides' cap on a post's text and an assignee's address, in UTF-8 bytes. */
const MAX_COMMENT_BYTES = 2048;
/** Comment threads per page of list_comments. */
const DEFAULT_THREADS = 50;
/** A post's text in a write result; Slides caps what it accepts well below this. */
const MAX_POST_BYTES = 8 * 1024;

/** EMU per point, the two units a Slides transform uses. */
const EMU_PER_PT = 12_700;

/**
 * The partial responses the projected reads ask for: ids, names, and text,
 * without the styles that are most of a deck's bytes. Each element kind keeps
 * one field Slides always sets, so its presence survives the mask. Groups stay
 * whole, because a mask cannot recurse into their children. get_presentation
 * and get_page ask for the same element fields, so both read a page's
 * elements identically — the same reading order, the same text — and a
 * cursor one issues the other honors.
 */
const TEXT_ONLY = "text(textElements(textRun(content),autoText(content)))";
const ELEMENT_FIELDS =
  "objectId,title,description,transform,elementGroup,line(lineType),image(contentUrl),video(source)," +
  `sheetsChart(spreadsheetId),wordArt,table(rows,columns,tableRows(tableCells(${TEXT_ONLY}))),` +
  `shape(shapeType,placeholder(type,index,parentObjectId),${TEXT_ONLY})`;
const LAYOUT_FIELDS =
  "masters(objectId,masterProperties(displayName)),layouts(objectId,layoutProperties(name,displayName,masterObjectId))," +
  "notesMaster(objectId)";
const PRESENTATION_FIELDS = [
  "presentationId",
  "title",
  "revisionId",
  "locale",
  "pageSize",
  LAYOUT_FIELDS,
  `slides(objectId,slideProperties(layoutObjectId,isSkipped,notesPage(objectId,notesProperties,pageElements(${ELEMENT_FIELDS}))),` +
    `pageElements(${ELEMENT_FIELDS}))`,
].join(",");
const PAGE_FIELDS = [
  "objectId",
  "pageType",
  "revisionId",
  "slideProperties(layoutObjectId,masterObjectId,isSkipped,notesPage(objectId))",
  "layoutProperties(name,displayName,masterObjectId)",
  "masterProperties(displayName)",
  "notesProperties(speakerNotesObjectId)",
  `pageElements(${ELEMENT_FIELDS})`,
].join(",");
const LAYOUT_LIST_FIELDS = `presentationId,revisionId,${LAYOUT_FIELDS}`;
/**
 * A deck's threads, and the anchors on every page a comment can sit on that
 * place them: slides, their notes pages, layouts, masters, the notes master.
 */
const COMMENT_DECK_FIELDS =
  "presentationId,revisionId,commentsViewMode,comments," +
  "slides(objectId,commentAnchors,slideProperties(notesPage(objectId,commentAnchors)))," +
  "layouts(objectId,commentAnchors),masters(objectId,commentAnchors),notesMaster(objectId,commentAnchors)";
const COMMENT_PAGE_FIELDS = "objectId,revisionId,commentsViewMode,comments,commentAnchors";

type JsonRecord = Record<string, any>;

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

function editUrl(presentationId: string): string {
  return `https://docs.google.com/presentation/d/${encodeURIComponent(presentationId)}/edit`;
}

// --- Result size --------------------------------------------------------------------

/**
 * The postcondition every read result meets: one result, under the shared
 * budget, whichever way it was called. Each read is built to fit, so this
 * failing means a shape the building missed; it refuses, explicitly, rather
 * than hand back a result neither delivery route can carry.
 */
function deliverable<T>(
  result: T,
  tool: string,
  advice = "read a smaller part, or through slides_api_read, which pages in chunks",
): T {
  const bytes = jsonBytes(result);
  if (bytes > RESULT_BUDGET_BYTES) {
    throw new ConnectorCallError(
      "connector_call_failed",
      `${tool} built a result of ${bytes} bytes, more than one result can carry (${RESULT_BUDGET_BYTES}). It only read, so nothing was changed; ${advice}.`,
      { retryable: false },
    );
  }
  return result;
}

/**
 * The same postcondition for a write's result, which comes after Google
 * answered 2xx: the write has applied, so a result too large to deliver is
 * refused with that said, and with where to see the outcome — never as if
 * nothing changed, and never as something to retry.
 */
function appliedDeliverable<T>(result: T, tool: string, reread: string): T {
  const bytes = jsonBytes(result);
  if (bytes > RESULT_BUDGET_BYTES)
    throw appliedButUnreadable(tool, `its result is ${bytes} bytes, more than one result can carry`, reread);
  return result;
}

function appliedButUnreadable(tool: string, why: string, reread: string): ConnectorCallError {
  return new ConnectorCallError(
    "connector_call_failed",
    `${tool} applied — Google answered 2xx — but ${why}. Do not repeat it; ${reread}.`,
    { retryable: false },
  );
}

/** A label cut to `maxBytes` of JSON, saying where the whole of it is. */
function label(ctx: ConnectorContext, value: string | undefined, maxBytes: number, whole: string): string | undefined {
  return value === undefined
    ? undefined
    : clampText(ctx, value, maxBytes, (dropped) => `[… ${dropped} more characters; ${whole}]`);
}

/** The first `max` UTF-16 units of `value`, never ending half a surrogate pair. */
function headOf(value: string, max: number): string {
  if (value.length <= max) return value;
  const code = value.charCodeAt(max - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * The longest prefix of `value` whose JSON fits `maxBytes` together with the
 * marker its cut earns, as text and as the number of characters it keeps.
 * `value` is text whose sent secrets were replaced before any page of it was
 * cut, so a continuation's offsets count the same text.
 */
function prefixWithin(
  value: string,
  maxBytes: number,
  marker: (dropped: number) => string,
): { text: string; kept: number } {
  let dropped = 0;
  const clamped = clampRedactedText(value, maxBytes, (count) => {
    dropped = count;
    return marker(count);
  });
  if (clamped === value) return { text: value, kept: value.length };
  if (clamped === "") return { text: "", kept: 0 };
  return { text: clamped, kept: value.length - dropped };
}

// --- Cursors ------------------------------------------------------------------------

/**
 * Where a read continues, and the deck state it continues from. Opaque to a
 * caller: base64url JSON, checked field by field on the way back in.
 */
interface Cursor {
  /** The tool that issued it. */
  k: "deck" | "layouts" | "page" | "comments";
  /** The presentation it continues, and for get_page and a page's list_comments the page. */
  p: string;
  g?: string | undefined;
  /** The state it was issued at: `r:` and the revision, or `f:` and a fingerprint. */
  s: string;
  /** The next row: slide, layout, element, or comment thread. */
  i: number;
  /** Within a thread: the part it continues — 0 the quote, 1 the head post, 2 on its replies. */
  j?: number | undefined;
  /** Within that row or part: a text offset, or a raw JSON offset. */
  o?: number | undefined;
}

const CURSOR_TOOLS: Readonly<Record<Cursor["k"], string>> = {
  deck: "get_presentation",
  layouts: "list_layouts",
  page: "get_page",
  comments: "list_comments",
};

function cursorText(cursor: Cursor): string {
  return JSON.stringify(compact(cursor));
}

/**
 * A cursor of connecta's claims: the presentation and page the caller named,
 * or a page Slides reported, redacted ({@link redactSentSecrets}); a state
 * that holds Slides' revision only when it carries no sent value
 * ({@link stateOf}); and offsets. An agent decodes it and no later pass reads
 * through its encoding.
 */
function encodeCursor(ctx: ConnectorContext, cursor: Cursor): string {
  return encodeForAgent(ctx, cursorText(cursor), { url: true, claims: true });
}

/**
 * A cursor this tool issued for this deck and page, in this mode, or a
 * refusal that says which of those it is not. The state is checked later,
 * against the deck as it is read.
 */
function decodeCursor(value: unknown, expected: { k: Cursor["k"]; p: string; g?: string }): Cursor | undefined {
  if (value === undefined) return undefined;
  const refuse = (why: string) =>
    new ConnectorCallError("invalid_args", `${why} Omit cursor to start from the beginning.`);
  let cursor: Cursor;
  try {
    const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    cursor = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
  } catch {
    throw refuse("cursor is not one this connection issued; pass page.nextCursor back unchanged.");
  }
  const counter = (field: unknown) => field === undefined || (Number.isSafeInteger(field) && (field as number) >= 0);
  if (
    !cursor ||
    typeof cursor !== "object" ||
    typeof cursor.p !== "string" ||
    typeof cursor.s !== "string" ||
    !Number.isSafeInteger(cursor.i) ||
    cursor.i < 0 ||
    !counter(cursor.o) ||
    !counter(cursor.j)
  ) {
    throw refuse("cursor is not one this connection issued; pass page.nextCursor back unchanged.");
  }
  if (cursor.k !== expected.k) {
    const tool = Object.hasOwn(CURSOR_TOOLS, cursor.k) ? CURSOR_TOOLS[cursor.k] : undefined;
    throw refuse(
      tool
        ? `cursor belongs to another tool (${tool}).`
        : "cursor is not one this connection issued; pass page.nextCursor back unchanged.",
    );
  }
  if (cursor.p !== expected.p) throw refuse("cursor continues a different presentation.");
  if ((cursor.g ?? undefined) !== expected.g) throw refuse("cursor continues a different page.");
  return cursor;
}

/**
 * List cursors can bind to the revision. Text offsets also bind to a SHA-256
 * of the redacted representation, even with a revision: a different request's
 * secret set can change that text without changing the deck. Viewers without
 * a revision always bind to the content their paging depends on.
 */
async function stateOf(
  ctx: ConnectorContext,
  revisionId: unknown,
  fingerprint: () => unknown,
  bindRepresentation = false,
): Promise<string> {
  // A revision that holds a sent value is bound by its digest instead: a cursor carries no downstream text.
  if (
    !bindRepresentation &&
    typeof revisionId === "string" &&
    revisionId !== "" &&
    redactSentSecrets(ctx, revisionId) === revisionId
  )
    return `r:${revisionId}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([revisionId ?? null, fingerprint()])),
    ),
  );
  return `f:${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A cursor's deck changed under it: continuing could skip or repeat. */
function assertUnchanged(cursor: Cursor | undefined, state: string, what: string): void {
  if (cursor && cursor.s !== state) {
    throw new ConnectorCallError(
      "conflict",
      `The ${what} changed since this cursor was issued, so continuing from it could skip or repeat what changed. Start again without a cursor.`,
    );
  }
}

/** A shape's or cell's text: runs and auto text in order, soft breaks as newlines. */
function textOf(ctx: ConnectorContext, content: unknown): string {
  let out = "";
  for (const element of asArray(asRecord(content)["textElements"]).map(asRecord)) {
    const run = asRecord(element["textRun"])["content"] ?? asRecord(element["autoText"])["content"];
    if (typeof run === "string") out += run;
  }
  return redactBeforeCut(ctx, out).replaceAll("\u000b", "\n").replace(/\s+$/, "");
}

/** A table as tab-separated cells, one row per line. */
function tableText(ctx: ConnectorContext, table: JsonRecord): string {
  return asArray(table["tableRows"])
    .map((row) =>
      asArray(asRecord(row)["tableCells"])
        .map((cell) => textOf(ctx, asRecord(cell)["text"]).replace(/[\t\n]+/g, " "))
        .join("\t")
        .replace(/\t+$/, ""),
    )
    .join("\n")
    .replace(/\s+$/, "");
}

/** The affine matrix of a transform, in EMU: [a, b, c, d, e, f]. */
type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * A transform as a matrix. ProtoJSON omits a zero, and a zero scale is real —
 * a group turned 90° has none — so an omitted coefficient of a present
 * transform is 0. Only a transform that is absent altogether is the identity.
 */
function matrixOf(transform: unknown): Matrix {
  if (!transform || typeof transform !== "object" || Array.isArray(transform)) return IDENTITY;
  const t = transform as JsonRecord;
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const unit = t["unit"] === "PT" ? EMU_PER_PT : 1;
  return [
    n(t["scaleX"]),
    n(t["shearY"]),
    n(t["shearX"]),
    n(t["scaleY"]),
    n(t["translateX"]) * unit,
    n(t["translateY"]) * unit,
  ];
}

/** `parent` preconcatenated with `child`, as Slides composes group transforms. */
function compose(parent: Matrix, child: Matrix): Matrix {
  const [a, b, c, d, e, f] = parent;
  const [ca, cb, cc, cd, ce, cf] = child;
  return [a * ca + c * cb, b * ca + d * cb, a * cc + c * cd, b * cc + d * cd, a * ce + c * cf + e, b * ce + d * cf + f];
}

type ElementKind = "shape" | "table" | "wordArt" | "image" | "video" | "chart" | "line" | "other";

/** One leaf of a page — groups opened — with what both readers derive from it. */
interface Leaf {
  element: JsonRecord;
  groupId: string | undefined;
  kind: ElementKind;
  /** Its readable text, whole: a shape's, a table's cells, word art's. */
  text: string;
  x: number;
  y: number;
}

function kindOf(element: JsonRecord): ElementKind {
  if (element["shape"]) return "shape";
  if (element["table"]) return "table";
  if (element["wordArt"]) return "wordArt";
  if (element["image"]) return "image";
  if (element["video"]) return "video";
  if (element["sheetsChart"]) return "chart";
  if (element["line"]) return "line";
  return "other";
}

function collect(
  ctx: ConnectorContext,
  elements: unknown,
  parent: Matrix,
  groupId: string | undefined,
  depth: number,
  out: Leaf[],
): void {
  for (const element of asArray(elements).map(asRecord)) {
    const matrix = compose(parent, matrixOf(element["transform"]));
    const group = asRecord(element["elementGroup"]);
    if (Array.isArray(group["children"]) && depth < 20) {
      collect(ctx, group["children"], matrix, text(element["objectId"]), depth + 1, out);
      continue;
    }
    const kind = kindOf(element);
    out.push({
      element,
      groupId,
      kind,
      text:
        kind === "shape"
          ? textOf(ctx, asRecord(element["shape"])["text"])
          : kind === "table"
            ? tableText(ctx, asRecord(element["table"]))
            : kind === "wordArt"
              ? (text(asRecord(element["wordArt"])["renderedText"]) ?? "")
              : "",
      x: matrix[4],
      y: matrix[5],
    });
  }
}

/**
 * A page's leaf elements in reading order: top to bottom, then left to right,
 * by absolute position rounded to the point, so a hairline offset does not
 * reorder a row. The index into this list is what a get_page cursor counts.
 */
function readingOrder(ctx: ConnectorContext, elements: unknown): Leaf[] {
  const out: Leaf[] = [];
  collect(ctx, elements, IDENTITY, undefined, 0, out);
  // Text is cut, and continued from an offset, only with every secret the
  // request sent replaced: a cut through an echo leaves a fragment.
  for (const leaf of out) leaf.text = redactBeforeCut(ctx, leaf.text);
  return out.sort(
    (left, right) =>
      Math.round(left.y / EMU_PER_PT) - Math.round(right.y / EMU_PER_PT) ||
      Math.round(left.x / EMU_PER_PT) - Math.round(right.x / EMU_PER_PT),
  );
}

/** What a projected page's cursor depends on when there is no revision. */
function leafFingerprint(leaves: readonly Leaf[]): unknown {
  // The text itself, not its length: a continuation resumes at a character
  // offset, and an edit that keeps the length still moves what is there.
  return leaves.map((leaf) => [leaf.element["objectId"] ?? null, leaf.kind, leaf.text]);
}

function placeholderOf(leaf: Leaf): JsonRecord {
  return leaf.kind === "shape" ? asRecord(asRecord(leaf.element["shape"])["placeholder"]) : {};
}

function altTextOf(element: JsonRecord): string | undefined {
  return [text(element["title"]), text(element["description"])].filter(Boolean).join(": ") || undefined;
}

/** The fields of an element both readers share: what it is, and how to address it. */
function describeLeaf(ctx: ConnectorContext, leaf: Leaf, raw: string): JsonRecord {
  const placeholder = placeholderOf(leaf);
  return compact({
    objectId: text(leaf.element["objectId"]),
    kind: leaf.kind,
    placeholder: text(placeholder["type"]),
    altText: label(ctx, altTextOf(leaf.element), MAX_ALT_TEXT_BYTES, raw),
    // A linked chart's data lives in Sheets; the id is how to reach it.
    spreadsheetId: leaf.kind === "chart" ? text(asRecord(leaf.element["sheetsChart"])["spreadsheetId"]) : undefined,
  });
}

const FULL_STRUCTURE = "slides_api_read has the complete structure";

// --- get_presentation ---------------------------------------------------------------

const TITLE_PLACEHOLDERS = new Set(["TITLE", "CENTERED_TITLE"]);

/** Everything about a deck one slide's projection needs. */
interface DeckContext {
  presentationId: string;
  revisionId: unknown;
  layouts: ReadonlyMap<string, string>;
}

/** Why text was cut, as the marker tells the reader. */
const RAISE_CAP = "raise maxCharsPerSlide, or continue with get_page from textCursor";
const OVER_RESULT = "this slide is larger than one result can carry; continue with get_page from textCursor";

/**
 * One slide's projection: its elements' text in reading order under a shared
 * per-slide character budget, its speaker notes under the same budget apart,
 * and, for every cut, the get_page cursor that reads on from the cut.
 */
async function projectSlide(
  ctx: ConnectorContext,
  value: unknown,
  index: number,
  deck: DeckContext,
  maxChars: number,
  why = RAISE_CAP,
): Promise<JsonRecord> {
  const slide = asRecord(value);
  const slideId = text(slide["objectId"]) ?? "";
  // Slides' ids enter a cursor only redacted, as every downstream value a cursor holds does.
  const cursorPage = redactSentSecrets(ctx, slideId);
  const properties = asRecord(slide["slideProperties"]);
  const leaves = readingOrder(ctx, slide["pageElements"]);
  let state: Promise<string> | undefined;
  const slideState = () => (state ??= stateOf(ctx, deck.revisionId, () => leafFingerprint(leaves), true));
  let budget = maxChars;
  let truncated = false;
  let omitted = 0;
  let title: string | undefined;
  const elements: JsonRecord[] = [];
  for (const [position, leaf] of leaves.entries()) {
    const placeholder = text(placeholderOf(leaf)["type"]);
    const alt = altTextOf(leaf.element);
    // Decorative lines and empty boxes carry nothing to read; they are
    // counted, not listed. An empty placeholder is kept: its id is where
    // insertText fills a new slide's title or body.
    if (
      leaf.kind === "line" ||
      (!leaf.text && !alt && !placeholder && (leaf.kind === "shape" || leaf.kind === "wordArt"))
    ) {
      omitted += 1;
      continue;
    }
    if (placeholder && TITLE_PLACEHOLDERS.has(placeholder) && title === undefined && leaf.text) {
      const line = leaf.text.replace(/\n+/g, " ");
      const keep = headOf(line, Math.min(MAX_TITLE_CHARS, maxChars));
      title =
        keep.length < line.length
          ? `${keep}\n[… ${line.length - keep.length} more characters; the title element's text has them]`
          : line;
    }
    const row = describeLeaf(ctx, leaf, FULL_STRUCTURE);
    if (row["altText"] !== alt) truncated = true;
    if (leaf.text) {
      const kept = headOf(leaf.text, Math.max(budget, 0));
      budget -= kept.length;
      if (kept.length < leaf.text.length) {
        truncated = true;
        row["text"] = `${kept}\n[… ${leaf.text.length - kept.length} more characters truncated; ${why}]`;
        row["truncated"] = true;
        row["textCursor"] = encodeCursor(ctx, {
          k: "page",
          p: deck.presentationId,
          g: cursorPage,
          s: await slideState(),
          i: position,
          o: kept.length,
        });
      } else {
        row["text"] = kept;
      }
    }
    row["position"] = position;
    elements.push(row);
  }
  const notesPage = asRecord(properties["notesPage"]);
  const notesPageId = text(notesPage["objectId"]);
  const notesId = text(asRecord(notesPage["notesProperties"])["speakerNotesObjectId"]);
  const notesLeaves = readingOrder(ctx, notesPage["pageElements"]);
  const notesAt = notesLeaves.findIndex((leaf) => notesId !== undefined && leaf.element["objectId"] === notesId);
  const notesText = notesAt >= 0 ? notesLeaves[notesAt]!.text : "";
  let notes: string | undefined;
  let notesCursor: string | undefined;
  if (notesText) {
    const kept = headOf(notesText, maxChars);
    if (kept.length < notesText.length) {
      truncated = true;
      notes = `${kept}\n[… ${notesText.length - kept.length} more characters truncated; ${why.replace("textCursor", "notesCursor")}]`;
      notesCursor = encodeCursor(ctx, {
        k: "page",
        p: deck.presentationId,
        g: redactSentSecrets(ctx, notesPageId ?? ""),
        s: await stateOf(ctx, deck.revisionId, () => leafFingerprint(notesLeaves), true),
        i: notesAt,
        o: kept.length,
      });
    } else {
      notes = notesText;
    }
  }
  const layoutId = text(properties["layoutObjectId"]);
  return compact({
    objectId: slideId || undefined,
    index,
    layout: layoutId ? deck.layouts.get(layoutId) : undefined,
    layoutId,
    skipped: properties["isSkipped"] === true || undefined,
    title,
    elements,
    omittedElements: omitted > 0 ? omitted : undefined,
    notesPageId,
    notes,
    notesCursor,
    truncated: truncated || undefined,
    // Kept for fitting: where each listed element sits among the page's
    // leaves, which an elementsCursor counts. Removed before returning.
    _state: slideState,
  });
}

/** A projected slide as returned: the fitting bookkeeping gone. */
function finished(slide: JsonRecord): JsonRecord {
  const { _state, ...rest } = slide;
  return {
    ...rest,
    elements: asArray(rest["elements"]).map((element) => {
      const { position: _position, ...row } = asRecord(element);
      return row;
    }),
  };
}

/**
 * A page's first slide that is too large for the `room` left, made to fit:
 * its text halved until it does, then — for a slide of so many elements that
 * it does not fit with no text — its last elements left out, counted, and
 * named by the get_page cursor that lists them. Every cut says it was the
 * result's size, not maxCharsPerSlide. A later slide that does not fit starts
 * the next page whole instead.
 */
async function fitSlide(
  ctx: ConnectorContext,
  value: unknown,
  index: number,
  deck: DeckContext,
  maxChars: number,
  room: number,
): Promise<JsonRecord> {
  for (let chars = Math.floor(maxChars / 2); ; chars = Math.floor(chars / 2)) {
    const slide = await projectSlide(ctx, value, index, deck, chars, OVER_RESULT);
    if (jsonBytes(finished(slide)) <= room) return finished(slide);
    if (chars > 0) continue;
    const elements = asArray(slide["elements"]).map(asRecord);
    const state = await (slide["_state"] as () => Promise<string>)();
    const keeping = (count: number) =>
      finished({
        ...slide,
        elements: elements.slice(0, count),
        elementsNotShown: elements.length - count,
        elementsCursor: encodeCursor(ctx, {
          k: "page",
          p: deck.presentationId,
          g: redactSentSecrets(ctx, text(asRecord(value)["objectId"]) ?? ""),
          s: state,
          i: count < elements.length ? Number(elements[count]!["position"]) : 0,
        }),
        truncated: true,
      });
    let low = 0;
    let high = elements.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (jsonBytes(keeping(middle)) <= room) low = middle;
      else high = middle - 1;
    }
    // The result's postcondition refuses a slide that still does not fit.
    return keeping(low);
  }
}

// --- Layouts ------------------------------------------------------------------------

/** Masters, each followed by its layouts, as rows create_slide and get_page take ids from. */
function layoutRows(ctx: ConnectorContext, presentation: JsonRecord): JsonRecord[] {
  const whole = "get_page on this id through slides_api_read has the whole name";
  const masters = asArray(presentation["masters"]).map(asRecord);
  const layouts = asArray(presentation["layouts"]).map(asRecord);
  const layoutRow = (layout: JsonRecord) => {
    const properties = asRecord(layout["layoutProperties"]);
    return compact({
      objectId: text(layout["objectId"]),
      kind: "layout",
      name: label(ctx, text(properties["name"]), MAX_NAME_BYTES, whole),
      displayName: label(ctx, text(properties["displayName"]), MAX_NAME_BYTES, whole),
      masterId: text(properties["masterObjectId"]),
    });
  };
  const rows: JsonRecord[] = [];
  const placed = new Set<JsonRecord>();
  for (const master of masters) {
    const id = text(master["objectId"]);
    rows.push(
      compact({
        objectId: id,
        kind: "master",
        displayName: label(ctx, text(asRecord(master["masterProperties"])["displayName"]), MAX_NAME_BYTES, whole),
      }),
    );
    for (const layout of layouts) {
      if (id !== undefined && asRecord(layout["layoutProperties"])["masterObjectId"] === id) {
        rows.push(layoutRow(layout));
        placed.add(layout);
      }
    }
  }
  for (const layout of layouts) if (!placed.has(layout)) rows.push(layoutRow(layout));
  return rows;
}

/** What a list_layouts cursor depends on when there is no revision. */
function layoutFingerprint(rows: readonly JsonRecord[]): unknown {
  return rows.map((row) => row["objectId"] ?? null);
}

/** A layout's name as a person picks it, bounded: its display name, else its kind. */
function layoutNames(ctx: ConnectorContext, presentation: JsonRecord): Map<string, string> {
  const names = new Map<string, string>();
  for (const layout of asArray(presentation["layouts"]).map(asRecord)) {
    const id = text(layout["objectId"]);
    const properties = asRecord(layout["layoutProperties"]);
    const name = label(
      ctx,
      text(properties["displayName"]) ?? text(properties["name"]),
      MAX_NAME_BYTES,
      "get_page on layoutId through slides_api_read has the whole name",
    );
    if (id && name) names.set(id, name);
  }
  return names;
}

/**
 * Rows from `start` that fit `room` bytes and `limit` rows, as a page of
 * them and the index the next page starts at.
 */
function rowsWithin(
  rows: readonly JsonRecord[],
  start: number,
  limit: number,
  room: number,
): { rows: JsonRecord[]; next: number } {
  const out: JsonRecord[] = [];
  let used = 2;
  let next = start;
  while (next < rows.length && out.length < limit) {
    const size = jsonBytes(rows[next]) + 1;
    if (used + size > room) break;
    out.push(rows[next]!);
    used += size;
    next += 1;
  }
  return { rows: out, next };
}

function dimension(value: unknown): { magnitude: number; unit: string } | undefined {
  const record = asRecord(value);
  return typeof record["magnitude"] === "number"
    ? { magnitude: record["magnitude"], unit: text(record["unit"]) ?? "EMU" }
    : undefined;
}

/** The size of a page object carrying the longest cursor a result may hold. */
function pageEnvelopeBytes(cursor: Cursor): number {
  const longest = { ...cursor, i: 999_999, o: 99_999_999, j: cursor.j === undefined ? undefined : 999_999 };
  const units = Math.ceil((new TextEncoder().encode(cursorText(longest)).length * 4) / 3);
  return 1024 + jsonBytes({ page: { hasMore: true, nextCursor: "x".repeat(units) } });
}

// --- get_page -------------------------------------------------------------------------

/** What get_page says about the page itself, by the page's kind. */
function describePage(ctx: ConnectorContext, page: JsonRecord): JsonRecord {
  const whole = "slides_api_read has the whole name";
  const slide = asRecord(page["slideProperties"]);
  const layout = asRecord(page["layoutProperties"]);
  return compact({
    pageType: text(page["pageType"]),
    layoutId: text(slide["layoutObjectId"]),
    masterId: text(slide["masterObjectId"]) ?? text(layout["masterObjectId"]),
    notesPageId: text(asRecord(slide["notesPage"])["objectId"]),
    skipped: slide["isSkipped"] === true || undefined,
    speakerNotesObjectId: text(asRecord(page["notesProperties"])["speakerNotesObjectId"]),
    name: label(ctx, text(layout["name"]), MAX_NAME_BYTES, whole),
    displayName: label(
      ctx,
      text(layout["displayName"]) ?? text(asRecord(page["masterProperties"])["displayName"]),
      MAX_NAME_BYTES,
      whole,
    ),
  });
}

interface PageRows {
  elements: JsonRecord[];
  properties?: JsonRecord;
  propertiesJson?: JsonRecord;
  next: { i: number; o?: number } | undefined;
}

/**
 * Projected rows of a page from element `i`, text offset `o`: every leaf,
 * in reading order, with its text continued across pages wherever one page
 * cannot hold it.
 */
function projectedRows(
  ctx: ConnectorContext,
  leaves: readonly Leaf[],
  start: { i: number; o: number },
  limit: number,
  room: number,
): PageRows {
  const elements: JsonRecord[] = [];
  let used = 2;
  let index = start.i;
  let offset = start.o;
  while (index < leaves.length && elements.length < limit) {
    const leaf = leaves[index]!;
    const placeholder = placeholderOf(leaf);
    const row: JsonRecord = {
      ...describeLeaf(ctx, leaf, FULL_STRUCTURE),
      ...compact({
        groupId: leaf.groupId,
        placeholderIndex: typeof placeholder["index"] === "number" ? placeholder["index"] : undefined,
        placeholderParentId: text(placeholder["parentObjectId"]),
        textOffset: offset > 0 ? offset : undefined,
      }),
    };
    const rest = leaf.text.slice(offset);
    if (!rest) {
      const size = jsonBytes(row) + 1;
      if (used + size > room) break;
      elements.push(row);
      used += size;
      index += 1;
      offset = 0;
      continue;
    }
    // The row as it would be if its text were cut, so the text's share is
    // measured against everything else the row carries.
    const shell = { ...row, text: "", truncated: true, textLength: leaf.text.length };
    const available = room - used - 1 - (jsonBytes(shell) - 2);
    const cut =
      available > 2
        ? prefixWithin(rest, available, (dropped) => `\n[… ${dropped} more characters continue on the next page]`)
        : { text: "", kept: 0 };
    if (cut.kept === 0 && elements.length > 0) break;
    if (cut.kept === rest.length) {
      const whole = { ...row, text: rest };
      used += jsonBytes(whole) + 1;
      elements.push(whole);
      index += 1;
      offset = 0;
      continue;
    }
    if (cut.kept === 0) {
      throw new ConnectorCallError(
        "connector_call_failed",
        "get_page could not fit any of an element's text in one result.",
        { retryable: false },
      );
    }
    elements.push({ ...shell, text: cut.text });
    return { elements, next: { i: index, o: offset + cut.kept } };
  }
  return { elements, next: index < leaves.length ? { i: index, o: offset } : undefined };
}

// --- Writing ----------------------------------------------------------------------

/**
 * One batchUpdate. A write that names `requiredRevisionId` is revision
 * guarded: the shared layer turns Slides' precondition refusal into a
 * `conflict`, so a deck someone changed since the read is re-read, not
 * retried. Nothing was applied in that case: a batch Slides refuses applies
 * none of its requests. One it accepts applies its deck changes together,
 * and its comment changes apart (see {@link commentSaveFields}).
 */
function batchUpdate(
  client: GoogleClient,
  presentationId: string,
  requests: unknown[],
  requiredRevisionId?: string,
): Effect.Effect<JsonRecord, HttpFailure, CallServices> {
  return Effect.gen(function* () {
    return asRecord(
      yield* client.json(
        {
          method: "POST",
          template: "/presentations/{presentationId}:batchUpdate",
          path: `/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
          body: compact({
            requests,
            writeControl: requiredRevisionId === undefined ? undefined : { requiredRevisionId },
          }),
        },
        { revisionGuarded: requiredRevisionId !== undefined },
      ),
    );
  });
}

/**
 * A create whose outcome Google left uncertain — sent with no answer back, a
 * redirect, a server failure after it was sent, or a 2xx whose answer broke —
 * keeps the shared verdict and adds what to look for before creating again,
 * since a second create makes a second deck or slide. Only a request that
 * never left, or that Google explicitly refused, is known not to have
 * applied, so every other dispatched outcome gets the advice, whatever phase
 * name the shared layer gives it. The advice claims nothing about whether it
 * applied; the shared verdict says that, and says "probably applied" only
 * after a recorded 2xx. Any other failure passes through.
 */
function afterUnknownCreate(
  connection: Connection,
  failure: HttpFailure,
  lookFor: string,
): Effect.Effect<never, HttpFailure, CallServices> {
  const outcome = googleOutcomeOf(failure);
  return outcome?.dispatched === true && outcome.phase !== "refused"
    ? googleFailureMessage(connection, failure, (message) => `${message} ${lookFor}`)
    : Effect.fail(failure);
}

/**
 * A field that names something to address later: objectId, commentId,
 * postId, anchorId, … — and a post author's `user`, the `users/{id}` that
 * identifies who wrote it.
 */
const ID_KEY = /^(id|user|[a-z][A-Za-z0-9]*Id)$/;

/**
 * An id as copied from Google into a result: whole, or not at all. A cut id
 * names nothing, so one too long to return is dropped and flagged instead.
 */
function wholeId(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && jsonBytes(value) <= MAX_ID_BYTES ? value : undefined;
}

/**
 * `value` keeping, at any depth, every id whole, every number and boolean,
 * and — in "short" mode — strings short enough to read at a glance; every
 * path left out goes to `cut`. Every array item is walked in both modes, so
 * no id is dropped to save space — the result's budget, which counts what
 * does not fit, handles that; past the first few items, "short" mode keeps
 * only their ids.
 * Nesting deeper than any reply Slides sends is cut where it starts.
 */
function pruned(
  value: unknown,
  key: string,
  path: string,
  mode: "short" | "ids",
  cut: string[],
  depth: number,
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const keep = ID_KEY.test(key)
      ? wholeId(value) !== undefined
      : mode === "short" && jsonBytes(value) <= MAX_NAME_BYTES;
    if (keep) return value;
    cut.push(path);
    return undefined;
  }
  if (typeof value !== "object" || depth >= MAX_REPLY_DEPTH) {
    cut.push(path);
    return undefined;
  }
  if (Array.isArray(value)) {
    // Every item is walked; past the first few, only for ids, whose cut
    // fields are summed up in one entry rather than one per item.
    if (mode === "short" && value.length > MAX_REPLY_ITEMS) {
      cut.push(`${path}[${MAX_REPLY_ITEMS}…${value.length - 1}] (ids only)`);
    }
    return value.map((item, index) => {
      const itemMode = mode === "short" && index >= MAX_REPLY_ITEMS ? "ids" : mode;
      const sink = itemMode === mode ? cut : [];
      return pruned(item, key, `${path}[${index}]`, itemMode, sink, depth + 1) ?? null;
    });
  }
  const out: JsonRecord = {};
  for (const [field, item] of Object.entries(value)) {
    const kept = pruned(item, field, path ? `${path}.${field}` : field, mode, cut, depth + 1);
    if (kept !== undefined) out[field] = kept;
  }
  return out;
}

/** The paths a summary left out, bounded: the first ten, then a count. */
function cutList(ctx: ConnectorContext, cut: readonly string[]): string[] {
  const named = cut.slice(0, 10).map((path) => clampText(ctx, path, 160, () => "…"));
  return cut.length > named.length ? [...named, `(${cut.length - named.length} more)`] : named;
}

/**
 * One batchUpdate reply, small enough to return. Slides' replies are tiny —
 * a new object's id, a count — and pass whole. One that is not is walked:
 * every id at every depth is kept whole, then short fields while they fit,
 * and every path left out is named in `cut`, so nothing is dropped without a
 * word.
 */
function summarizeReply(ctx: ConnectorContext, reply: JsonRecord): JsonRecord {
  if (jsonBytes(reply) <= MAX_REPLY_BYTES) return reply;
  let summary: JsonRecord = {};
  for (const mode of ["short", "ids"] as const) {
    const cut: string[] = [];
    summary = { ...asRecord(pruned(reply, "", "", mode, cut, 0)), cut: cutList(ctx, cut) };
    if (jsonBytes(summary) <= MAX_REPLY_BYTES) return summary;
  }
  // Ids alone over the per-reply share: still returned, since what a write
  // created is the one thing a caller cannot ask for again.
  return summary;
}

/**
 * The most one host result may carry into an execute_code program
 * (`MAX_HOST_RESULT_BYTES` in `src/executors/quickjs-runtime.ts`). A write
 * result past the provider's own 192 KiB budget but under this still reaches
 * a program; past it, only a direct call does, paging with connecta.result.
 */
const BRIDGE_BYTES = 256 * 1024;

/**
 * The most a raw batch's result may be when the ids its replies carry
 * outgrow one result. Every id is still returned, never dropped: a direct
 * call stashes a result this size and pages it with connecta.result (the stash
 * holds 8 MiB by default). Past this, the ids are not returned at all, and
 * the result says where to read them.
 */
const MAX_IDS_RESULT_BYTES = 4 * 1024 * 1024;

/**
 * A reply at its smallest, however small it already is: every id at every
 * depth with its numbers and booleans, and how many fields were left out.
 * A reply with nothing but those passes unchanged.
 */
function idsOnlyReply(reply: JsonRecord): JsonRecord {
  const cut: string[] = [];
  const ids = asRecord(pruned(reply, "", "", "ids", cut, 0));
  return cut.length === 0 ? reply : { ...ids, cut: [`(${cut.length} fields left out; ids only)`] };
}

/**
 * A batch's replies, in order, after `used` bytes: ids first, then text.
 * Every reply starts at its ids alone, and replies are then given their
 * fuller summaries, in order, while the provider's 192 KiB budget holds
 * them, so text is cut before any id is. Should the ids alone outgrow that
 * budget, they are all returned anyway (`oversized`) and no text is; nothing
 * a write created is ever dropped to save space.
 */
function boundedReplies(
  ctx: ConnectorContext,
  replies: readonly unknown[],
  used: number,
): { replies: JsonRecord[]; oversized: boolean } {
  const out = replies.map((reply) => idsOnlyReply(asRecord(reply)));
  const sizes = out.map((reply) => jsonBytes(reply) + 1);
  let total = used + 2 + sizes.reduce((sum, size) => sum + size, 0);
  if (total > RESULT_BUDGET_BYTES) return { replies: out, oversized: true };
  for (const [index, reply] of replies.entries()) {
    const fuller = summarizeReply(ctx, asRecord(reply));
    const size = jsonBytes(fuller) + 1;
    if (total - sizes[index]! + size > RESULT_BUDGET_BYTES) continue;
    total += size - sizes[index]!;
    out[index] = fuller;
    sizes[index] = size;
  }
  return { replies: out, oversized: false };
}

/**
 * The revision a write left the deck at, for the next write to name — whole,
 * or flagged as not shown when too long to copy, never cut.
 */
function revisionFields(response: JsonRecord): { revisionId?: string; revisionIdNotShown?: true } {
  const revision = asRecord(response["writeControl"])["requiredRevisionId"];
  const whole = wholeId(revision);
  if (whole !== undefined) return { revisionId: whole };
  return typeof revision === "string" && revision !== "" ? { revisionIdNotShown: true } : {};
}

// --- Comments ---------------------------------------------------------------------

/**
 * What a batch's comment changes came to, as a result field. A batch with no
 * comment request is settled unless Slides says otherwise. One with any is
 * settled only on `ALL_SAVED`: anything else — a failure, or no state at all —
 * is surfaced by name, since its deck changes may have applied while its
 * comments did not, and the batch is then neither all nor none.
 */
function commentSaveFields(
  ctx: ConnectorContext,
  response: JsonRecord,
  sentComments: boolean,
): { commentUpdateState?: string } {
  const state = text(response["commentUpdateState"]);
  const settled = sentComments ? state === "ALL_SAVED" : state === undefined || COMMENTS_SETTLED.has(state);
  if (settled) return {};
  return {
    commentUpdateState:
      label(ctx, state ?? COMMENT_STATE_UNSPECIFIED, MAX_NAME_BYTES, "Slides sent a longer state") ?? "",
  };
}

/** What a write whose comments did not all save tells its caller. */

/** One post's fields, its text apart: the text pages, the rest is small. */
interface PostPart {
  row: JsonRecord;
  content: string;
  /** An id or author id too long to copy, left out rather than cut. */
  idsNotShown: boolean;
}

/** Comment actions that change nothing, and are left unsaid. */
const QUIET_ACTIONS: ReadonlySet<string> = new Set(["COMMENT_ACTION_TYPE_UNSPECIFIED", "NO_COMMENT_ACTION_CHANGE"]);

/**
 * A post as returned: its id and its author's `users/{id}` whole — left out
 * and flagged on the thread's `idsNotShown`, never cut, should either be too
 * long to copy — beside the display name, which is not an identity.
 * `contentHtml` is the same text rendered, and is left behind.
 */
function postPart(ctx: ConnectorContext, value: unknown): PostPart {
  const post = asRecord(value);
  const author = asRecord(post["author"]);
  const postId = wholeId(post["postId"]);
  const user = wholeId(author["user"]);
  const shownAuthor = compact({
    user,
    displayName: label(ctx, text(author["displayName"]), MAX_NAME_BYTES, "Slides shows the whole name"),
    me: author["me"] === true || undefined,
    anonymous: author["anonymous"] === true || undefined,
  });
  const action = text(post["commentAction"]);
  const whole = "Slides shows all of it";
  return {
    row: compact({
      postId,
      author: Object.keys(shownAuthor).length > 0 ? shownAuthor : undefined,
      commentAction: action && !QUIET_ACTIONS.has(action) ? label(ctx, action, MAX_NAME_BYTES, whole) : undefined,
      assigneeEmail: label(ctx, text(post["assigneeEmail"]), MAX_COMMENT_BYTES + 64, whole),
      createTime: label(ctx, text(post["createTime"]), MAX_NAME_BYTES, whole),
      updateTime: label(ctx, text(post["updateTime"]), MAX_NAME_BYTES, whole),
      deleted: post["deleted"] === true || undefined,
      // Slides gives an imported post no author id; this says why.
      imported: post["fromImportedPresentation"] === true || undefined,
    }),
    // Paged from offsets, so replaced before any cut (see readingOrder).
    content: typeof post["content"] === "string" ? redactBeforeCut(ctx, post["content"]) : "",
    idsNotShown:
      (text(post["postId"]) !== undefined && postId === undefined) ||
      (text(author["user"]) !== undefined && user === undefined),
  };
}

/** A post in a write result: its text bounded, never its ids. */
function writtenPost(ctx: ConnectorContext, value: unknown, maxBytes = MAX_POST_BYTES): JsonRecord {
  const post = postPart(ctx, value);
  return compact({
    ...post.row,
    content: label(ctx, text(post.content), maxBytes, "list_comments has the whole post"),
  });
}

/** Where an anchor sits: the pages it is on, and the elements on them it covers. */
interface AnchorPlace {
  pages: Set<string>;
  objects: Set<string>;
}

function anchorPlaces(pages: readonly JsonRecord[]): Map<string, AnchorPlace> {
  const places = new Map<string, AnchorPlace>();
  for (const page of pages) {
    const pageId = text(page["objectId"]);
    for (const anchor of asArray(page["commentAnchors"]).map(asRecord)) {
      const anchorId = text(anchor["anchorId"]);
      if (anchorId === undefined) continue;
      let place = places.get(anchorId);
      if (!place) places.set(anchorId, (place = { pages: new Set(), objects: new Set() }));
      if (pageId) place.pages.add(pageId);
      for (const object of asArray(anchor["objectAnchors"]).map(asRecord)) {
        // An anchor on the page itself names the page, already listed.
        const objectId = text(object["objectId"]);
        if (objectId && objectId !== pageId) place.objects.add(objectId);
      }
    }
  }
  return places;
}

/** Every page a deck read returns anchors on: slides, notes pages, layouts, masters, the notes master. */
function commentPages(presentation: JsonRecord): JsonRecord[] {
  const slides = asArray(presentation["slides"]).map(asRecord);
  return [
    ...slides,
    ...slides.map((slide) => asRecord(asRecord(slide["slideProperties"])["notesPage"])),
    ...asArray(presentation["layouts"]).map(asRecord),
    ...asArray(presentation["masters"]).map(asRecord),
    asRecord(presentation["notesMaster"]),
  ];
}

/** One thread: its fields, and the texts that page — its quote, its head post, its replies. */
interface ThreadParts {
  row: JsonRecord;
  quote: string;
  head: PostPart | undefined;
  replies: PostPart[];
}

function threadParts(ctx: ConnectorContext, value: unknown, places: ReadonlyMap<string, AnchorPlace>): ThreadParts {
  const thread = asRecord(value);
  const commentId = wholeId(thread["commentId"]);
  const anchorId = wholeId(thread["anchorId"]);
  const place = anchorId === undefined ? undefined : places.get(anchorId);
  const ids = (values: Iterable<string> | undefined) =>
    [...(values ?? [])].map(wholeId).filter((id): id is string => id !== undefined);
  const pageIds = ids(place?.pages);
  const objectIds = ids(place?.objects);
  const replies = asArray(thread["replies"]).map((reply) => postPart(ctx, reply));
  const head =
    thread["headPost"] && typeof thread["headPost"] === "object" ? postPart(ctx, thread["headPost"]) : undefined;
  return {
    row: compact({
      commentId,
      anchorId,
      status: label(ctx, text(thread["status"]), MAX_NAME_BYTES, "Slides shows the status"),
      // Every id, as everywhere: Slides anchors a group's comment to at most
      // 100 elements, and the page's budget holds them.
      pageObjectIds: pageIds.length > 0 ? pageIds : undefined,
      objectIds: objectIds.length > 0 ? objectIds : undefined,
      replyCount: replies.length,
      idsNotShown:
        (text(thread["commentId"]) !== undefined && commentId === undefined) ||
        (text(thread["anchorId"]) !== undefined && anchorId === undefined) ||
        head?.idsNotShown ||
        replies.some((reply) => reply.idsNotShown) ||
        undefined,
    }),
    quote: typeof thread["plainTextQuote"] === "string" ? redactBeforeCut(ctx, thread["plainTextQuote"]) : "",
    head,
    replies,
  };
}

/**
 * A post row carrying `content` from `offset`, and, when cut — which also
 * marks its thread `truncated` — the whole length in `contentLength`.
 */
function postRow(post: PostPart, content: string, offset: number, cutFrom: number | undefined): JsonRecord {
  return compact({
    ...post.row,
    content: content === "" && cutFrom === undefined ? undefined : content,
    contentOffset: offset > 0 ? offset : undefined,
    contentLength: cutFrom,
  });
}

/**
 * Part `j` of a thread placed into its row with `content` from `offset`:
 * 0 the quote, 1 the head post, 2 on each reply in turn. `undefined` for a
 * part the thread does not have. `cutFrom`, the part's whole length, marks it
 * cut.
 */
function placePart(
  thread: ThreadParts,
  row: JsonRecord,
  j: number,
  content: string,
  offset: number,
  cutFrom?: number,
): JsonRecord | undefined {
  if (j === 0) {
    if (thread.quote === "") return undefined;
    return compact({ ...row, quote: content, quoteOffset: offset > 0 ? offset : undefined, quoteLength: cutFrom });
  }
  if (j === 1) return thread.head ? { ...row, headPost: postRow(thread.head, content, offset, cutFrom) } : undefined;
  const reply = thread.replies[j - 2];
  if (!reply) return undefined;
  const replies = asArray(row["replies"]);
  return compact({
    ...row,
    // A row that continues a thread from a previous page starts its replies past 0.
    repliesOffset: replies.length === 0 && j > 2 ? j - 2 : row["repliesOffset"],
    replies: [...replies, postRow(reply, content, offset, cutFrom)],
  });
}

function partText(thread: ThreadParts, j: number): string {
  if (j === 0) return thread.quote;
  if (j === 1) return thread.head?.content ?? "";
  return thread.replies[j - 2]?.content ?? "";
}

interface ThreadPage {
  threads: JsonRecord[];
  next: { i: number; j: number; o: number } | undefined;
}

/**
 * Thread rows from thread `i`, part `j`, text offset `o`, under `limit` rows
 * and `room` bytes. Every thread's ids come whole on every row it appears
 * on; a quote or post too long for what is left is cut at a character, and
 * the next page continues that thread (`continued`) from the cut — the same
 * way get_page continues an element's text.
 */
function threadRows(
  threads: readonly ThreadParts[],
  start: { i: number; j: number; o: number },
  limit: number,
  room: number,
): ThreadPage {
  const out: JsonRecord[] = [];
  let used = 2;
  let { i, j, o } = start;
  const fits = (row: JsonRecord) => used + jsonBytes(row) + 1 <= room;
  const unfit = () =>
    new ConnectorCallError(
      "connector_call_failed",
      "list_comments could not fit any of a comment thread in one result; slides_api_read pages it in JSON chunks.",
      {
        retryable: false,
      },
    );
  while (i < threads.length && out.length < limit) {
    const thread = threads[i]!;
    // Where this row starts: a row that places nothing leaves the next page
    // to start here, so it is not called continued for parts it skipped.
    const from = { i, j, o };
    let row: JsonRecord = compact({ ...thread.row, continued: j > 0 || o > 0 ? true : undefined });
    if (!fits(row)) {
      if (out.length > 0) break;
      throw unfit();
    }
    let placed = false;
    for (const parts = thread.replies.length + 2; j < parts; j += 1, o = 0) {
      const whole = partText(thread, j);
      const rest = whole.slice(o);
      const next = placePart(thread, row, j, rest, o);
      if (next === undefined) continue;
      if (fits(next)) {
        row = next;
        placed = true;
        continue;
      }
      // The row as it would be with this part cut, so the text's share is
      // measured against everything else the row carries.
      const shell = { ...placePart(thread, row, j, "", o, whole.length), truncated: true };
      const available = room - used - 1 - (jsonBytes(shell) - 2);
      const cut =
        available > 2 && rest !== ""
          ? prefixWithin(rest, available, (dropped) => `\n[… ${dropped} more characters continue on the next page]`)
          : { text: "", kept: 0 };
      if (cut.kept === 0) {
        if (!placed) {
          if (out.length > 0) return { threads: out, next: from };
          throw unfit();
        }
        out.push({ ...row, truncated: true });
        return { threads: out, next: { i, j, o } };
      }
      out.push({ ...placePart(thread, row, j, cut.text, o, whole.length), truncated: true });
      return { threads: out, next: { i, j, o: o + cut.kept } };
    }
    out.push(row);
    used += jsonBytes(row) + 1;
    i += 1;
    j = 0;
    o = 0;
  }
  return { threads: out, next: i < threads.length ? { i, j, o } : undefined };
}

/**
 * The state a list_comments cursor binds to: the revision, the threads
 * themselves, and the anchors that place them. Slides saves comments apart
 * from the deck, so a reply added between pages need not move the revision,
 * and an anchor moved from one element to another need not change a thread;
 * binding to the exact JSON of both makes either a `conflict`, never a page
 * that skips, repeats, or places a thread where it no longer is.
 */
function commentsState(
  ctx: ConnectorContext,
  revisionId: unknown,
  comments: readonly unknown[],
  pages: readonly JsonRecord[],
): Promise<string> {
  return stateOf(ctx, undefined, () => [
    text(revisionId) ?? null,
    comments,
    pages.map((page) => [page["objectId"] ?? null, page["commentAnchors"] ?? null]),
  ]);
}

/** A 403 on a comment read: what it most likely means, beside Google's words. */
function commentAccess(connection: Connection, failure: HttpFailure): Effect.Effect<never, HttpFailure, CallServices> {
  return googleOutcomeOf(failure)?.status === 403
    ? googleFailureMessage(
        connection,
        failure,
        (message) =>
          `${message} Reading comments needs comment access: an account that may only view the deck cannot read them.`,
      )
    : Effect.fail(failure);
}

/** A comment's text, refused locally past Slides' own cap rather than sent to fail. */
function commentText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const content = String(value);
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > MAX_COMMENT_BYTES) {
    throw new ConnectorCallError(
      "invalid_args",
      `${field} is ${bytes} UTF-8 bytes; Slides accepts at most ${MAX_COMMENT_BYTES}. Nothing was sent.`,
    );
  }
  return content;
}

/**
 * One comment request as its own batch, and what its result always carries:
 * the deck, the revision it left, and — whenever Slides does not confirm the
 * comment saved — the state it reported and what to do about it.
 */
function commentWrite(
  client: GoogleClient,
  ctx: ConnectorContext,
  presentationId: string,
  request: JsonRecord,
  requiredRevisionId?: string,
): Effect.Effect<{ reply: JsonRecord; header: JsonRecord; saved: boolean }, HttpFailure, CallServices> {
  return Effect.gen(function* () {
    const response = yield* batchUpdate(client, presentationId, [request], requiredRevisionId);
    const state = commentSaveFields(ctx, response, true);
    return {
      reply: asRecord(asArray(response["replies"])[0]),
      header: compact({ presentationId, ...revisionFields(response), ...state }),
      saved: state.commentUpdateState === undefined,
    };
  });
}

/**
 * One post added to a thread — a reply, or a status or assignee change —
 * and its result: the new post's id and author whole, or the write's comment
 * state when Slides does not confirm it saved.
 */
function postToThread(
  connection: Connection,
  client: GoogleClient,
  ctx: ConnectorContext,
  tool: string,
  args: Record<string, any>,
  post: JsonRecord,
): Effect.Effect<JsonRecord, HttpFailure, CallServices> {
  return Effect.gen(function* () {
    const written = yield* commentWrite(client, ctx, args["presentationId"], {
      addCommentReply: { commentId: args["commentId"], post: compact(post) },
    }).pipe(
      Effect.catch((failure) =>
        afterUnknownCreate(
          connection,
          failure,
          "Read the thread with list_comments and look for the post before sending it again; a second one is a second post.",
        ),
      ),
    );
    const reread = "read the thread with list_comments to find the post";
    const created = asRecord(written.reply["addCommentReply"])["post"];
    if (wholeId(asRecord(created)["postId"]) === undefined && written.saved) {
      throw appliedButUnreadable(tool, "Google returned no usable id for the new post", reread);
    }
    return appliedDeliverable(
      compact({
        ...written.header,
        commentId: args["commentId"],
        post: created && typeof created === "object" ? writtenPost(ctx, created) : undefined,
        idsNotShown: postPart(ctx, created).idsNotShown || undefined,
        note: written.saved ? undefined : COMMENTS_UNSAVED,
      }),
      tool,
      reread,
    );
  });
}

export function slidesTools({ connection }: { connection: Connection }): ApiTool[] {
  const client = googleClient(connection, SLIDES.provider, { standard: true, index: SLIDES_INDEX });
  const readOnly = { readOnlyHint: true } as const;
  const presentationPath = (id: string) => `/presentations/${encodeURIComponent(id)}`;
  const nextPage = (cursor: string | null) =>
    cursor === null ? { hasMore: false } : { hasMore: true, nextCursor: cursor };

  const declarations: SlidesToolDeclaration[] = [
    {
      name: "get_presentation",
      description:
        "Read a Google Slides deck: title, page size, revisionId, layouts, and each slide's text in reading order with speaker notes, capped per slide. Cannot find decks; that is Drive's job.",
      annotations: readOnly,
      input: contracts.get_presentation.input,
      output: contracts.get_presentation.output,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const presentationId: string = args["presentationId"];

          const cursor = decodeCursor(args["cursor"], { k: "deck", p: presentationId });
          const presentation = asRecord(
            yield* client.json({
              method: "GET",
              template: "/presentations/{presentationsId}",
              path: presentationPath(presentationId),
              query: { fields: PRESENTATION_FIELDS },
            }),
          );
          const all = asArray(presentation["slides"]);
          const revisionId = presentation["revisionId"];
          const state = yield* Effect.promise(() =>
            stateOf(ctx, revisionId, () => all.map((slide) => asRecord(slide)["objectId"] ?? null)),
          );
          assertUnchanged(cursor, state, "deck's slides");
          const start = cursor?.i ?? 0;
          const limit = typeof args["limit"] === "number" ? args["limit"] : DEFAULT_PAGE_SIZE;
          const maxChars =
            typeof args["maxCharsPerSlide"] === "number" ? args["maxCharsPerSlide"] : DEFAULT_SLIDE_CHARS;
          const deck: DeckContext = { presentationId, revisionId, layouts: layoutNames(ctx, presentation) };
          const pageSize = asRecord(presentation["pageSize"]);
          const width = dimension(pageSize["width"]);
          const height = dimension(pageSize["height"]);
          // The first projected page previews the layouts, bounded; the rest
          // continue in list_layouts from layoutsCursor.
          let preview: JsonRecord = {};
          if (start === 0) {
            const rows = layoutRows(ctx, presentation);
            const shown = rowsWithin(rows, 0, MAX_ROWS, MAX_LAYOUT_PREVIEW_BYTES);
            preview = compact({
              layouts: shown.rows,
              layoutsNotShown: shown.next < rows.length ? rows.length - shown.next : undefined,
              layoutsCursor:
                shown.next < rows.length
                  ? encodeCursor(ctx, {
                      k: "layouts",
                      p: presentationId,
                      s: yield* Effect.promise(() => stateOf(ctx, revisionId, () => layoutFingerprint(rows))),
                      i: shown.next,
                    })
                  : undefined,
            });
          }
          const header = compact({
            presentationId: text(presentation["presentationId"]) ?? presentationId,
            title: label(ctx, text(presentation["title"]), MAX_TITLE_BYTES, "Drive shows the whole title"),
            // Only an account that may edit the deck is given one.
            revisionId: text(revisionId),
            url: editUrl(presentationId),
            locale: text(presentation["locale"]),
            canvasSize: width && height ? { width, height } : undefined,
            slideCount: all.length,
            // The one page no slide, layout, or master links to; get_page reads it.
            notesMasterId: text(asRecord(presentation["notesMaster"])["objectId"]),
            ...preview,
          });
          const issue = (i: number) => encodeCursor(ctx, { k: "deck", p: presentationId, s: state, i });
          // A page ends at the slide limit or at the byte budget, whichever is
          // first; the budget counts the header and the longest cursor.
          let used =
            jsonBytes({ ...header, slides: [] }) + pageEnvelopeBytes({ k: "deck", p: presentationId, s: state, i: 0 });
          const slides: JsonRecord[] = [];
          let next = start;
          while (next < all.length && slides.length < limit) {
            const room = RESULT_BUDGET_BYTES - used - 1;
            let slide = finished(yield* Effect.promise(() => projectSlide(ctx, all[next], next, deck, maxChars)));
            let size = jsonBytes(slide);
            if (size > room) {
              if (slides.length > 0) break;
              slide = yield* Effect.promise(() => fitSlide(ctx, all[next], next, deck, maxChars, room));
              size = jsonBytes(slide);
            }
            slides.push(slide);
            used += size + 1;
            next += 1;
          }
          return deliverable(
            { ...header, slides, page: nextPage(next < all.length ? issue(next) : null) },
            "get_presentation",
          );
        }),
    },
    {
      name: "get_page",
      description:
        "Read one page by objectId — slide, layout, master, or notes page — every element in reading order, with placeholder ids and text continued across pages.",
      annotations: readOnly,
      input: contracts.get_page.input,
      output: contracts.get_page.output,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const presentationId: string = args["presentationId"];
          const pageObjectId: string = args["pageObjectId"];

          const cursor = decodeCursor(args["cursor"], { k: "page", p: presentationId, g: pageObjectId });
          const page = asRecord(
            yield* client.json({
              method: "GET",
              template: "/presentations/{presentationId}/pages/{pageObjectId}",
              path: `${presentationPath(presentationId)}/pages/${encodeURIComponent(pageObjectId)}`,
              query: { fields: PAGE_FIELDS },
            }),
          );
          const leaves = readingOrder(ctx, page["pageElements"]);
          const state = yield* Effect.promise(() =>
            stateOf(ctx, page["revisionId"], () => leafFingerprint(leaves), true),
          );
          assertUnchanged(cursor, state, "page");
          const header = compact({
            presentationId,
            pageObjectId: text(page["objectId"]) ?? pageObjectId,
            revisionId: text(page["revisionId"]),
            ...describePage(ctx, page),
            elementCount: leaves.length,
          });
          const room =
            RESULT_BUDGET_BYTES -
            jsonBytes({ ...header, elements: [] }) -
            pageEnvelopeBytes({
              k: "page",
              p: presentationId,
              g: pageObjectId,
              s: state,
              i: 0,
            }) -
            64;
          const limit = typeof args["limit"] === "number" ? args["limit"] : DEFAULT_ELEMENTS;
          const start = { i: cursor?.i ?? 0, o: cursor?.o ?? 0 };
          const rows = projectedRows(ctx, leaves, start, limit, room);
          const nextCursor = rows.next
            ? encodeCursor(ctx, {
                k: "page",
                p: presentationId,
                g: pageObjectId,
                s: state,
                i: rows.next.i,
                o: rows.next.o ? rows.next.o : undefined,
              })
            : null;
          return deliverable(
            compact({
              ...header,
              properties: rows.properties,
              propertiesJson: rows.propertiesJson,
              elements: rows.elements,
              page: nextPage(nextCursor),
            }),
            "get_page",
          );
        }),
    },
    {
      name: "list_layouts",
      description:
        "List a deck's masters, each followed by its layouts, with the ids create_slide and get_page take. Names only; get_page reads a layout's placeholders.",
      annotations: readOnly,
      input: contracts.list_layouts.input,
      output: contracts.list_layouts.output,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const presentationId: string = args["presentationId"];
          const cursor = decodeCursor(args["cursor"], { k: "layouts", p: presentationId });
          const presentation = asRecord(
            yield* client.json({
              method: "GET",
              template: "/presentations/{presentationsId}",
              path: presentationPath(presentationId),
              query: { fields: LAYOUT_LIST_FIELDS },
            }),
          );
          const rows = layoutRows(ctx, presentation);
          const state = yield* Effect.promise(() =>
            stateOf(ctx, presentation["revisionId"], () => layoutFingerprint(rows)),
          );
          assertUnchanged(cursor, state, "deck's layouts");
          const header = compact({
            presentationId,
            revisionId: text(presentation["revisionId"]),
            notesMasterId: text(asRecord(presentation["notesMaster"])["objectId"]),
            total: rows.length,
          });
          const room =
            RESULT_BUDGET_BYTES -
            jsonBytes({ ...header, layouts: [] }) -
            pageEnvelopeBytes({ k: "layouts", p: presentationId, s: state, i: 0 });
          const limit = typeof args["limit"] === "number" ? args["limit"] : DEFAULT_LAYOUTS;
          const shown = rowsWithin(rows, cursor?.i ?? 0, limit, room);
          const next =
            shown.next < rows.length
              ? encodeCursor(ctx, { k: "layouts", p: presentationId, s: state, i: shown.next })
              : null;
          return deliverable({ ...header, layouts: shown.rows, page: nextPage(next) }, "list_layouts");
        }),
    },
    {
      name: "list_comments",
      description:
        "List a deck's comment threads, or one page's: anchor, status, quoted text, head post, and replies, each author by user id. Long text continues across pages.",
      annotations: readOnly,
      input: contracts.list_comments.input,
      output: contracts.list_comments.output,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const presentationId: string = args["presentationId"];
          const pageObjectId: string | undefined = args["pageObjectId"];

          const scope = pageObjectId === undefined ? {} : { g: pageObjectId };
          const cursor = decodeCursor(args["cursor"], { k: "comments", p: presentationId, ...scope });
          const source = asRecord(
            yield* client
              .json({
                method: "GET",
                template:
                  pageObjectId === undefined
                    ? "/presentations/{presentationsId}"
                    : "/presentations/{presentationId}/pages/{pageObjectId}",
                path:
                  pageObjectId === undefined
                    ? presentationPath(presentationId)
                    : `${presentationPath(presentationId)}/pages/${encodeURIComponent(pageObjectId)}`,
                query: {
                  commentsViewMode: COMMENTS_INCLUDED,
                  fields: pageObjectId === undefined ? COMMENT_DECK_FIELDS : COMMENT_PAGE_FIELDS,
                },
              })
              .pipe(Effect.catch((failure) => commentAccess(connection, failure))),
          );
          // Asked for INCLUDED, Slides either includes every thread or refuses;
          // a reply in any other mode could be missing threads, so it is not
          // passed off as the list.
          const mode = text(source["commentsViewMode"]);
          if (mode !== undefined && mode !== COMMENTS_INCLUDED) {
            throw new ConnectorCallError(
              "connector_call_failed",
              `Slides answered in comments view mode ${label(ctx, mode, MAX_NAME_BYTES, "")}, not ${COMMENTS_INCLUDED}, so its threads may be incomplete. It only read, so nothing was changed.`,
              { retryable: false },
            );
          }
          const comments = redactBeforeCut(ctx, asArray(source["comments"]));
          const pages = pageObjectId === undefined ? commentPages(source) : [source];
          const state = yield* Effect.promise(() => commentsState(ctx, source["revisionId"], comments, pages));
          assertUnchanged(cursor, state, pageObjectId === undefined ? "deck's comments" : "page's comments");
          const header = compact({
            presentationId,
            pageObjectId,
            revisionId: text(source["revisionId"]),
            total: comments.length,
          });
          const room =
            RESULT_BUDGET_BYTES -
            jsonBytes({ ...header, threads: [] }) -
            pageEnvelopeBytes({
              k: "comments",
              p: presentationId,
              ...scope,
              s: state,
              i: 0,
              j: 0,
            }) -
            64;
          const limit = typeof args["limit"] === "number" ? args["limit"] : DEFAULT_THREADS;
          let shown: { threads: JsonRecord[]; next: { i: number; j?: number; o?: number } | undefined };
          const places = anchorPlaces(pages);
          const threads = comments.map((thread) => threadParts(ctx, thread, places));
          shown = threadRows(threads, { i: cursor?.i ?? 0, j: cursor?.j ?? 0, o: cursor?.o ?? 0 }, limit, room);
          const next = shown.next
            ? encodeCursor(ctx, {
                k: "comments",
                p: presentationId,
                ...scope,
                s: state,
                i: shown.next.i,
                j: shown.next.j ? shown.next.j : undefined,
                o: shown.next.o ? shown.next.o : undefined,
              })
            : null;
          return deliverable(
            { ...header, threads: shown.threads, page: nextPage(next) },
            "list_comments",
            "pass a smaller limit, or one page's pageObjectId",
          );
        }),
    },
    {
      name: "get_slide_thumbnail",
      description:
        "Get a PNG thumbnail link for one slide: a URL valid about 30 minutes that opens as the user, plus its size. Never downloads the image.",
      annotations: readOnly,
      input: contracts.get_slide_thumbnail.input,
      output: contracts.get_slide_thumbnail.output,
      run: (args) =>
        Effect.gen(function* () {
          const thumbnail = asRecord(
            yield* client.json({
              method: "GET",
              template: "/presentations/{presentationId}/pages/{pageObjectId}/thumbnail",
              path: `/presentations/${encodeURIComponent(args["presentationId"])}/pages/${encodeURIComponent(args["slideObjectId"])}/thumbnail`,
              query: {
                "thumbnailProperties.mimeType": "PNG",
                "thumbnailProperties.thumbnailSize": args["size"],
              },
            }),
          );
          const contentUrl = text(thumbnail["contentUrl"]) ?? "";
          // A link is whole or useless, so one too long to pass on is refused,
          // never cut.
          if (jsonBytes(contentUrl) > MAX_URL_BYTES) {
            throw new ConnectorCallError(
              "connector_call_failed",
              `Google returned a thumbnail link of ${jsonBytes(contentUrl)} bytes, longer than this connection passes on (${MAX_URL_BYTES}). It only read, so nothing was changed; open the slide in Slides instead.`,
              { retryable: false },
            );
          }
          return deliverable(
            compact({
              contentUrl,
              width: typeof thumbnail["width"] === "number" ? thumbnail["width"] : undefined,
              height: typeof thumbnail["height"] === "number" ? thumbnail["height"] : undefined,
            }),
            "get_slide_thumbnail",
            "open the slide in Slides instead",
          );
        }),
    },
    {
      name: "create_presentation",
      description:
        "Create an empty Google Slides deck with one title slide in the user's My Drive root. It cannot place the deck in a folder or copy a template.",
      // Additive: a new file changes nothing that existed. Not read-only, so
      // program calls require a writable endpoint; other writes use
      // call_destructive_tool. The host controls approval.
      annotations: { readOnlyHint: false, destructiveHint: false },
      input: contracts.create_presentation.input,
      output: contracts.create_presentation.output,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const presentation = asRecord(
            yield* client
              .json({
                method: "POST",
                template: "/presentations",
                path: "/presentations",
                body: { title: args["title"] },
              })
              .pipe(
                Effect.catch((failure) =>
                  afterUnknownCreate(
                    connection,
                    failure,
                    "Search Drive for a deck with this title before creating it again; a second create makes a second deck.",
                  ),
                ),
              ),
          );
          const lookInDrive = "search Drive for the deck by its title";
          const id = wholeId(presentation["presentationId"]);
          if (id === undefined) {
            throw appliedButUnreadable(
              "create_presentation",
              "Google returned no usable id for the new deck",
              lookInDrive,
            );
          }
          const revisionId = presentation["revisionId"];
          const slideIds = asArray(presentation["slides"]).map((slide) => asRecord(slide)["objectId"]);
          const shownIds = slideIds.map(wholeId).filter((value): value is string => value !== undefined);
          return appliedDeliverable(
            compact({
              presentationId: id,
              revisionId: wholeId(revisionId),
              revisionIdNotShown: revisionId !== undefined && wholeId(revisionId) === undefined ? true : undefined,
              title: label(ctx, text(presentation["title"]), MAX_TITLE_BYTES, "Drive shows the whole title"),
              url: editUrl(id),
              slideObjectIds: shownIds,
              slideObjectIdsNotShown: shownIds.length < slideIds.length ? slideIds.length - shownIds.length : undefined,
            }),
            "create_presentation",
            lookInDrive,
          );
        }),
    },
    {
      name: "create_slide",
      description:
        "Add one empty slide to a deck, from a predefined layout or one of its own layouts, at an index or the end. Adds no text; nothing existing changes.",
      // Additive: later slides move down one place, and nothing is lost.
      annotations: { readOnlyHint: false, destructiveHint: false },
      input: contracts.create_slide.input,
      output: contracts.create_slide.output,
      run: (args) =>
        Effect.gen(function* () {
          if (args["layout"] !== undefined && args["layoutId"] !== undefined) {
            throw new ConnectorCallError("invalid_args", "Pass layout or layoutId, not both.");
          }
          const reference =
            args["layoutId"] !== undefined
              ? { layoutId: args["layoutId"] }
              : args["layout"] !== undefined
                ? { predefinedLayout: args["layout"] }
                : undefined;
          const response = yield* batchUpdate(client, args["presentationId"], [
            { createSlide: compact({ insertionIndex: args["insertionIndex"], slideLayoutReference: reference }) },
          ]).pipe(
            Effect.catch((failure) =>
              afterUnknownCreate(
                connection,
                failure,
                "Read the deck with get_presentation and look for the new slide before adding another.",
              ),
            ),
          );
          const reread = "read the deck with get_presentation to find the new slide";
          const slideObjectId = wholeId(asRecord(asRecord(asArray(response["replies"])[0])["createSlide"])["objectId"]);
          if (slideObjectId === undefined) {
            throw appliedButUnreadable("create_slide", "Google returned no usable id for the new slide", reread);
          }
          return appliedDeliverable(
            compact({ presentationId: args["presentationId"], ...revisionFields(response), slideObjectId }),
            "create_slide",
            reread,
          );
        }),
    },
    {
      name: "replace_all_text",
      description:
        "Replace every occurrence of literal text across a deck's slides, or the slides named, in one atomic write. No regex; formatting of the replaced text is kept.",
      // Destructive: the replaced text is gone, everywhere it matched.
      annotations: { readOnlyHint: false, destructiveHint: true },
      input: contracts.replace_all_text.input,
      output: contracts.replace_all_text.output,
      run: (args) =>
        Effect.gen(function* () {
          const replacements = asArray(args["replacements"]).map(asRecord);
          const response = yield* batchUpdate(
            client,
            args["presentationId"],
            replacements.map((replacement) => ({
              replaceAllText: compact({
                containsText: { text: replacement["find"], matchCase: replacement["matchCase"] !== false },
                replaceText: replacement["replace"],
                pageObjectIds: args["slideObjectIds"],
              }),
            })),
            args["requiredRevisionId"],
          );
          const replies = asArray(response["replies"]);
          const counted = replacements.map((replacement, index) => {
            // Proto3 omits a zero count.
            const changed = asRecord(asRecord(replies[index])["replaceAllText"])["occurrencesChanged"];
            // Echoed for reading the counts, not in full: fifty long finds
            // would make a large result of text the caller already has.
            const find = String(replacement["find"]);
            return {
              find: find.length > MAX_ECHO_CHARS ? `${headOf(find, MAX_ECHO_CHARS)}…` : find,
              occurrencesChanged: typeof changed === "number" ? changed : 0,
            };
          });
          return appliedDeliverable(
            compact({
              presentationId: args["presentationId"],
              ...revisionFields(response),
              occurrencesChanged: counted.reduce((sum, entry) => sum + entry.occurrencesChanged, 0),
              replacements: counted,
            }),
            "replace_all_text",
            "read the deck with get_presentation to see the replaced text",
          );
        }),
    },
    {
      name: "create_comment",
      description:
        "Comment on a slide, a notes page, an element, a range of its text, or a table cell, optionally assigning it. Adds a thread; Slides notifies as in the editor.",
      // Additive: a new thread changes nothing that existed. Not read-only,
      // so program calls require a writable endpoint; other writes use
      // call_destructive_tool. The host controls approval.
      annotations: { readOnlyHint: false, destructiveHint: false },
      input: contracts.create_comment.input,
      output: contracts.create_comment.output,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const content = commentText(args["content"], "content");
          const objectId: string = args["objectId"];
          const range = args["textRange"] === undefined ? undefined : asRecord(args["textRange"]);
          if (range && Number(range["endIndex"]) <= Number(range["startIndex"])) {
            throw new ConnectorCallError(
              "invalid_args",
              "textRange.endIndex must be greater than startIndex. Nothing was sent.",
            );
          }
          const textRange = range && {
            type: "FIXED_RANGE",
            startIndex: range["startIndex"],
            endIndex: range["endIndex"],
          };
          const cell = args["cell"] === undefined ? undefined : asRecord(args["cell"]);
          const location = cell && { rowIndex: cell["rowIndex"], columnIndex: cell["columnIndex"] };
          // One anchor: the object itself, text in a shape, text in a cell, or a whole cell.
          const anchor =
            location && textRange
              ? { tableCellTextAnchor: { objectId, cellLocation: location, textRange } }
              : location
                ? { tableAnchor: { objectId, tableRange: { location, rowSpan: 1, columnSpan: 1 } } }
                : textRange
                  ? { shapeTextAnchor: { objectId, textRange } }
                  : { objectId };
          const written = yield* commentWrite(
            client,
            ctx,
            args["presentationId"],
            { insertComment: compact({ ...anchor, content, assigneeEmailAddress: args["assigneeEmail"] }) },
            args["requiredRevisionId"],
          ).pipe(
            Effect.catch((failure) =>
              afterUnknownCreate(
                connection,
                failure,
                "List the deck's comments with list_comments and look for it before commenting again; a second insert makes a second thread.",
              ),
            ),
          );
          const reread = "list the deck's comments with list_comments to find it";
          const thread = asRecord(asRecord(written.reply["insertComment"])["commentThread"]);
          const commentId = wholeId(thread["commentId"]);
          if (commentId === undefined && written.saved) {
            throw appliedButUnreadable("create_comment", "Google returned no usable id for the new comment", reread);
          }
          const parts = threadParts(ctx, thread, new Map());
          const replies = asArray(thread["replies"]);
          return appliedDeliverable(
            compact({
              ...written.header,
              commentId,
              anchorId: wholeId(thread["anchorId"]),
              status: parts.row["status"],
              quote: label(ctx, text(parts.quote), MAX_POST_BYTES, "list_comments has the whole quote"),
              headPost: thread["headPost"] ? writtenPost(ctx, thread["headPost"]) : undefined,
              // A new thread has none; any Slides sends keep their ids.
              replies: replies.length > 0 ? replies.map((reply) => writtenPost(ctx, reply, MAX_NAME_BYTES)) : undefined,
              idsNotShown: parts.row["idsNotShown"],
              note: written.saved ? undefined : COMMENTS_UNSAVED,
            }),
            "create_comment",
            reread,
          );
        }),
    },
    {
      name: "create_comment_reply",
      description:
        "Reply to a comment thread. Adds a post and changes no existing one; to resolve, reopen, or reassign, use update_comment_thread.",
      // Additive: a reply is a new post, and the thread's status and
      // assignee stay as they were.
      annotations: { readOnlyHint: false, destructiveHint: false },
      input: contracts.create_comment_reply.input,
      output: contracts.create_comment_reply.output,
      run: (args, ctx) =>
        postToThread(connection, client, ctx, "create_comment_reply", args, {
          content: commentText(args["content"], "content"),
        }),
    },
    {
      name: "update_comment_thread",
      description:
        "Resolve, reopen, or reassign a comment thread with a post. Pass exactly one of status or assigneeEmail; reassignment requires content. Replaces its status or assignee; Slides notifies an assignee.",
      // Destructive: the thread's status or assignee is replaced. The post
      // that records it cannot be deleted afterwards.
      annotations: { readOnlyHint: false, destructiveHint: true },
      // Keep the field schema flat: discovery renders oneOf before properties,
      // losing these fields for required-only branches. The handler enforces
      // exactly one change and text on reassignment before dispatch instead.
      input: contracts.update_comment_thread.input,
      output: contracts.update_comment_thread.output,
      run: (args, ctx) =>
        Effect.gen(function* () {
          // Exactly one change per post. Slides requires text on reassignment;
          // only RESOLVE and REOPEN may go without.
          if ((args["status"] === undefined) === (args["assigneeEmail"] === undefined)) {
            throw new ConnectorCallError(
              "invalid_args",
              "Pass exactly one of status and assigneeEmail. Nothing was sent.",
            );
          }
          if (args["assigneeEmail"] !== undefined && args["content"] === undefined) {
            throw new ConnectorCallError(
              "invalid_args",
              "A reassignment needs content: Slides requires text on any post that does not resolve or reopen. Nothing was sent.",
            );
          }
          return yield* postToThread(connection, client, ctx, "update_comment_thread", args, {
            content: commentText(args["content"], "content"),
            commentAction:
              args["status"] === undefined ? undefined : args["status"] === "RESOLVED" ? "RESOLVE" : "REOPEN",
            assigneeEmail: args["assigneeEmail"],
          });
        }),
    },
    {
      name: "update_comment_post",
      description:
        "Replace the text of one post in a comment thread, the head post or a reply. Only its author can; the old text is gone.",
      // Destructive: the post's previous text is overwritten.
      annotations: { readOnlyHint: false, destructiveHint: true },
      input: contracts.update_comment_post.input,
      output: contracts.update_comment_post.output,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const content = commentText(args["content"], "content");
          const written = yield* commentWrite(client, ctx, args["presentationId"], {
            updateCommentPost: { commentId: args["commentId"], postId: args["postId"], content },
          });
          return appliedDeliverable(
            compact({
              ...written.header,
              commentId: args["commentId"],
              postId: args["postId"],
              note: written.saved ? undefined : COMMENTS_UNSAVED,
            }),
            "update_comment_post",
            "read the thread with list_comments to see the post",
          );
        }),
    },
    {
      name: "delete_comment",
      description:
        "Delete a whole comment thread, every reply with it. Only the author of its head post can, and the API cannot restore it.",
      // Destructive: the thread and its replies are gone.
      annotations: { readOnlyHint: false, destructiveHint: true },
      input: contracts.delete_comment.input,
      output: contracts.delete_comment.output,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const written = yield* commentWrite(client, ctx, args["presentationId"], {
            deleteComment: { commentId: args["commentId"] },
          });
          return appliedDeliverable(
            compact({
              ...written.header,
              commentId: args["commentId"],
              note: written.saved ? undefined : COMMENTS_UNSAVED,
            }),
            "delete_comment",
            "list the deck's comments with list_comments to see whether it is gone",
          );
        }),
    },
    {
      name: "delete_comment_reply",
      description:
        "Delete one reply from a comment thread. Only its author can, and not a reply that resolved, reopened, or assigned the thread.",
      // Destructive: the reply is gone.
      annotations: { readOnlyHint: false, destructiveHint: true },
      input: contracts.delete_comment_reply.input,
      output: contracts.delete_comment_reply.output,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const written = yield* commentWrite(client, ctx, args["presentationId"], {
            deleteCommentReply: { commentId: args["commentId"], postId: args["postId"] },
          });
          return appliedDeliverable(
            compact({
              ...written.header,
              commentId: args["commentId"],
              postId: args["postId"],
              note: written.saved ? undefined : COMMENTS_UNSAVED,
            }),
            "delete_comment_reply",
            "read the thread with list_comments to see whether it is gone",
          );
        }),
    },
    {
      name: "batch_update_presentation",
      description:
        "Send raw Slides batchUpdate requests to a deck at the revision it was read at; all apply or none, comments apart. Always destructive. Returns every new id; past 256 KiB, only a direct call can page them.",
      // Destructive: a raw request can delete or overwrite anything in the deck.
      annotations: { readOnlyHint: false, destructiveHint: true },
      input: contracts.batch_update_presentation.input,
      output: contracts.batch_update_presentation.output,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const requests = asArray(args["requests"]);
          const kinds = requests.map((request, index) => [index, Object.keys(asRecord(request))[0] ?? ""] as const);
          const unknown = kinds.filter(([, kind]) => !REQUEST_KINDS.includes(kind as (typeof REQUEST_KINDS)[number]));
          if (unknown.length > 0) {
            throw new ConnectorCallError(
              "invalid_args",
              `Not a Slides request kind: ${unknown
                .slice(0, 5)
                .map(([index, kind]) => `requests[${index}] "${kind.slice(0, 64)}"`)
                .join(
                  ", ",
                )}. Each request is one of Slides' Request kinds, such as insertText, deleteObject, or createShape; nothing was sent.`,
            );
          }
          const response = yield* batchUpdate(client, args["presentationId"], requests, args["requiredRevisionId"]);
          // Comment changes save apart from the rest of a batch, and Slides
          // reports them on their own: a batch that sent any is settled only
          // when Slides says ALL_SAVED, and one that is not stops being called
          // all or none.
          const saved = commentSaveFields(
            ctx,
            response,
            kinds.some(([, kind]) => COMMENT_KINDS.has(kind)),
          );
          const header = compact({ presentationId: args["presentationId"], ...revisionFields(response), ...saved });
          // One reply per request, in order; most are empty, the create replies
          // carry the new ids. Bounded, ids first: Slides accepted the batch, so
          // what it created must reach the caller.
          const comments = kinds.some(([, kind]) => COMMENT_KINDS.has(kind));
          const reread = `re-read with get_presentation or get_page for deck changes${comments ? ", and list_comments for comments" : ""}`;
          const all = asArray(response["replies"]);
          const shown = boundedReplies(ctx, all, jsonBytes(header) + 1024);
          // Neutral about what applied: the comment state, when unconfirmed,
          // says that apart; these say only what the result left out.
          const unsaved = saved.commentUpdateState !== undefined ? COMMENTS_UNSAVED : undefined;
          const notes = (...entries: (string | undefined)[]) => {
            const said = entries.filter((entry): entry is string => entry !== undefined);
            return said.length > 0 ? `${said.join(" ")} To see the deck as it is now, ${reread}.` : undefined;
          };
          const result = compact({
            ...header,
            replies: shown.replies,
            note: notes(
              unsaved,
              shown.replies.some((reply) => "cut" in reply)
                ? `Large reply fields are named in truncated; every id is kept${shown.oversized ? ", and no other text, since the ids alone pass this tool's 192 KiB budget" : ""}.`
                : undefined,
            ),
          });
          const bytes = jsonBytes(result);
          if (bytes <= BRIDGE_BYTES) return result;
          if (bytes <= MAX_IDS_RESULT_BYTES) {
            return {
              ...result,
              note: `${result.note ?? ""} At ${bytes} bytes this result is more than execute_code can carry (${BRIDGE_BYTES}): call the tool directly and page it with connecta.result.`.trim(),
            };
          }
          // Past any result: the save state and how to recover the ids stay;
          // the replies do not. Slides accepted the batch, so it is not to be sent again.
          return compact({
            ...header,
            replies: [],
            repliesNotShown: all.length,
            note: notes(
              unsaved,
              `Slides accepted the batch, but its ${all.length} replies carry ${bytes} bytes of ids, more than any result can carry, so none is shown. Do not send it again; ${comments ? "list_comments has the comments and posts it created, and " : ""}get_presentation or get_page has the objects.`,
            ),
          });
        }),
    },
  ];
  return declarations.map((declaration) => {
    const isList = declaration.name.startsWith("list_");
    const rowNames = new Set(
      Object.keys(declaration.name === "list_layouts" ? contracts.LayoutRow.fields : contracts.CommentRow.fields),
    );
    const spec = {
      name: declaration.name,
      description: declaration.description,
      input: isList
        ? (Schema.Struct({
            ...declaration.input.fields,
            fields: Schema.optionalKey(fieldsInput("Dot paths to keep in each item; only narrows the result.")),
          }) as typeof declaration.input)
        : declaration.input,
      output: declaration.output,
      ...(declaration.writeSteps ? { writeSteps: declaration.writeSteps } : {}),
      run: (args: Record<string, any>) =>
        Effect.gen(function* () {
          const problem = isList ? fieldsProblem(args["fields"], rowNames, "a Slides list item") : undefined;
          if (problem) return yield* Effect.fail(new Refusal({ error: problem }));
          const current = yield* Effect.serviceOption(Operation);
          if (Option.isNone(current) || !current.value)
            return yield* Effect.die(new Error("Slides requires a call context."));
          const ctx = current.value;
          const supplied = args["cursor"];
          const decoded =
            typeof supplied === "string" ? yield* boundCursor.decode("slides-content-v1", {}, supplied) : undefined;
          const result = yield* declaration.run(
            { ...args, ...(decoded === undefined ? {} : { cursor: decoded }) },
            ctx,
          );
          const normalized = normalizeResult(result, declaration.name);
          if (isList) normalized["items"] = selectFields(normalized["items"], args["fields"]);
          return yield* signContinuations(normalized, ctx);
        }).pipe(
          Effect.catchDefect((defect) =>
            defect instanceof ConnectorCallError ? Effect.fail(new Refusal({ error: defect })) : Effect.die(defect),
          ),
        ),
    };
    return declaration.annotations.readOnlyHint === true
      ? read(connection, { ...spec, ...(isList ? {} : { fields: true as const }) })
      : write(connection, { ...spec, destructive: declaration.annotations.destructiveHint === true });
  });
}

interface SlidesToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly annotations: NonNullable<ApiTool["annotations"]>;
  readonly input: Schema.Struct<Schema.Struct.Fields> & { readonly DecodingServices: never };
  readonly output: Schema.Schema<any>;
  readonly writeSteps?: Readonly<Record<string, "once">>;
  readonly run: (args: Record<string, any>, ctx: ConnectorContext) => Effect.Effect<any, HttpFailure, CallServices>;
}

/** Size reports name the cut paths; content cursors retain their independent offsets. */
function normalizeResult(value: unknown, tool: string): JsonRecord {
  const allCuts = new Set<string>();
  const normalize = (value: unknown, path = ""): unknown => {
    if (Array.isArray(value)) return value.map((item) => normalize(item, `${path}[]`));
    if (!value || typeof value !== "object") return value;
    const out: JsonRecord = {};
    const cut: string[] = [];
    const source = asRecord(value);
    for (const [key, item] of Object.entries(source)) {
      if (key === "truncated" && item === true) {
        if (source["textCursor"] || source["textLength"]) cut.push("text");
        if (source["notesCursor"]) cut.push("notes");
        if (!cut.length)
          cut.push(
            ...Object.keys(source).filter((name) => typeof source[name] === "string" && !/Id$|Cursor$/.test(name)),
          );
      } else if (key === "cut" && Array.isArray(item)) cut.push(...item.map(String));
      else if (["elementsNotShown", "layoutsNotShown", "repliesNotShown", "revisionIdNotShown"].includes(key)) {
        if (item) cut.push(key === "revisionIdNotShown" ? "revisionId" : key.replace("NotShown", "[]"));
      } else {
        out[key] = normalize(item, path ? `${path}.${key}` : key);
        if (typeof item === "string" && /\[… \d+ more characters[; ]/.test(item)) cut.push(key);
      }
    }
    if (cut.length) {
      out["truncated"] = [...new Set(cut)];
      for (const field of cut) allCuts.add(path ? `${path}.${field}` : field);
    }
    return out;
  };
  const result = asRecord(normalize(value));
  if (allCuts.size) result["truncated"] = [...allCuts];
  if (tool === "list_layouts" || tool === "list_comments") {
    const noun = tool === "list_layouts" ? "layouts" : "threads";
    result["items"] = result[noun];
    delete result[noun];
    if (allCuts.size) result["truncated"] = [...allCuts].map((path) => path.replace(`${noun}[]`, "items[]"));
    if (typeof result["total"] === "number") {
      result["page"] = { ...asRecord(result["page"]), total: result["total"] };
      delete result["total"];
    }
  }
  return result;
}

/** Cross-tool content cursors share one signed codec, bound to connection and owner. */
function signContinuations(value: unknown, ctx: ConnectorContext): Effect.Effect<any, HttpFailure, CallServices> {
  return Effect.gen(function* () {
    if (Array.isArray(value)) {
      const rows: unknown[] = [];
      for (const item of value) rows.push(yield* signContinuations(item, ctx));
      return rows;
    }
    if (!value || typeof value !== "object") return value;
    const out: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.endsWith("Cursor") && typeof item === "string") {
        out[key] = yield* boundCursor.encode("slides-content-v1", {}, item, (json) =>
          encodeForAgent(ctx, json, { url: true, claims: true }),
        );
      } else out[key] = yield* signContinuations(item, ctx);
    }
    return out;
  });
}
