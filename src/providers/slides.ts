/**
 * Google Slides as the signed-in Workspace user: read a deck's text slide by
 * slide, fetch a slide's thumbnail link, create a deck, add a slide, replace
 * text, and send raw `batchUpdate` requests behind approval. Hand-written
 * against the Slides API v1 reference
 * (https://developers.google.com/workspace/slides/api/reference/rest).
 *
 * Whose decks. Access is a service account with domain-wide delegation
 * (`src/providers/google/workspace.ts`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. Slides has no `users/me` to confine beneath — a presentation id
 * names a file in Drive — so the token's subject is the confinement: a
 * request reaches exactly the decks that person can open, and no argument
 * names an account.
 *
 * What it does not do. Slides has no list method; finding a deck is Drive's
 * job, and this connection says so rather than guessing. Nothing here shares,
 * moves, or deletes a file. Every write but the two additive ones is
 * destructive, and the raw hatch requires the revision it was read at, so a
 * request built against an old read cannot land on a deck someone else has
 * changed since.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `scripts/drift/slides-endpoints.json` records the four methods the tools
 * call, and `npm run providers:check -- --provider slides` reports a touched
 * contract that moved or a method that stopped accepting the scope below.
 */
import { apiConnector as api, defined, type ApiTool } from "../connectors/api-connector.js";
import { ConnectorCallError } from "../errors.js";
import type { Connector, ConnectorContext, JsonSchema } from "../types.js";
import {
  googleWorkspaceClient,
  workspaceConnection,
  type GoogleWorkspaceClient,
  type GoogleWorkspaceOptions,
} from "./google/workspace.js";

export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "./google/workspace.js";

/** The Slides API root. Every path beneath it names a presentation by id. */
export const SLIDES_API_BASE_URL = "https://slides.googleapis.com/v1";

/**
 * Exactly the scope this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list for it. `presentations`
 * reads and writes every deck the user can open; Slides offers nothing
 * narrower that can also write.
 */
export const SLIDES_SCOPES = ["https://www.googleapis.com/auth/presentations"] as const;

/** Options for {@link slides}: the shared Workspace delegation options. */
export type SlidesOptions = GoogleWorkspaceOptions;

/** Slides per page of get_presentation. Slides itself returns the whole deck. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
/** Text kept per slide (its elements together, and its notes apart). */
const DEFAULT_SLIDE_CHARS = 4_000;
const MAX_SLIDE_CHARS = 50_000;
/** A whole presentation without styles; with raw: true, with them. */
const SLIDES_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Requests per raw batch: connecta's bound; Slides publishes none. */
const MAX_BATCH_REQUESTS = 100;
const MAX_REPLACEMENTS = 50;
/**
 * Every kind of Request Slides' batchUpdate accepts, from its Discovery
 * document's `Request` schema. The raw hatch checks each request's one key
 * against this list, and nothing inside it: an unknown kind is a typo or a
 * new kind to review here, and refusing it locally costs no round trip. The
 * contents are Slides' to validate. Too many names for a schema enum inside
 * the H7 budget, so the handler holds the list. A kind Google adds moves
 * the batchUpdate contract `scripts/drift/slides-endpoints.json` records.
 */
const REQUEST_KINDS: ReadonlySet<string> = new Set([
  "addCommentReply",
  "createImage",
  "createLine",
  "createParagraphBullets",
  "createShape",
  "createSheetsChart",
  "createSlide",
  "createTable",
  "createVideo",
  "deleteComment",
  "deleteCommentReply",
  "deleteObject",
  "deleteParagraphBullets",
  "deleteTableColumn",
  "deleteTableRow",
  "deleteText",
  "duplicateObject",
  "groupObjects",
  "insertComment",
  "insertTableColumns",
  "insertTableRows",
  "insertText",
  "mergeTableCells",
  "refreshSheetsChart",
  "replaceAllShapesWithImage",
  "replaceAllShapesWithSheetsChart",
  "replaceAllText",
  "replaceImage",
  "rerouteLine",
  "ungroupObjects",
  "unmergeTableCells",
  "updateCommentPost",
  "updateImageProperties",
  "updateLineCategory",
  "updateLineProperties",
  "updatePageElementAltText",
  "updatePageElementTransform",
  "updatePageElementsZOrder",
  "updatePageProperties",
  "updateParagraphStyle",
  "updateShapeProperties",
  "updateSlideProperties",
  "updateSlidesPosition",
  "updateTableBorderProperties",
  "updateTableCellProperties",
  "updateTableColumnProperties",
  "updateTableRowProperties",
  "updateTextStyle",
  "updateVideoProperties",
]);

/**
 * Serialized bytes one get_presentation page may reach. A program's host
 * call carries at most 256 KiB (`MAX_HOST_RESULT_BYTES`), and a direct call
 * stashes anything past the inline cap for get_result; this stays under both
 * with room for the envelope, so no page is ever undeliverable.
 */
const MAX_RESULT_BYTES = 192 * 1024;
/** Of that, what the first page's layout list may take. */
const MAX_LAYOUT_BYTES = 24 * 1024;
const MAX_TITLE_CHARS = 500;
const MAX_ALT_TEXT_CHARS = 1_000;
/** replace_all_text echoes each find this far, in order with its count. */
const MAX_ECHO_CHARS = 100;

/** EMU per point, the two units a Slides transform uses. */
const EMU_PER_PT = 12_700;

/**
 * The partial response get_presentation asks for: ids, layout names, and
 * text, without the styles that are most of a deck's bytes. Each element kind
 * keeps one field Slides always sets, so its presence survives the mask.
 * Groups stay whole, because a mask cannot recurse into their children.
 */
const TEXT_ONLY = "text(textElements(textRun(content),autoText(content)))";
const PRESENTATION_FIELDS = [
  "presentationId",
  "title",
  "revisionId",
  "locale",
  "pageSize",
  "layouts(objectId,layoutProperties(name,displayName))",
  `slides(objectId,slideProperties(layoutObjectId,isSkipped,notesPage(notesProperties,pageElements(objectId,shape(${TEXT_ONLY})))),` +
    "pageElements(objectId,title,description,transform,elementGroup,line(lineType),image(contentUrl),video(source)," +
    `sheetsChart(spreadsheetId),wordArt,table(rows,columns,tableRows(tableCells(${TEXT_ONLY}))),` +
    `shape(shapeType,placeholder(type),${TEXT_ONLY})))`,
].join(",");

type JsonRecord = Record<string, any>;

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

function editUrl(presentationId: string): string {
  return `https://docs.google.com/presentation/d/${encodeURIComponent(presentationId)}/edit`;
}

// --- Reading a deck ---------------------------------------------------------------

/** A shape's or cell's text: runs and auto text in order, soft breaks as newlines. */
function textOf(content: unknown): string {
  let out = "";
  for (const element of asArray(asRecord(content)["textElements"]).map(asRecord)) {
    const run = asRecord(element["textRun"])["content"] ?? asRecord(element["autoText"])["content"];
    if (typeof run === "string") out += run;
  }
  return out.replaceAll("\u000b", "\n").replace(/\s+$/, "");
}

/** A table as tab-separated cells, one row per line. */
function tableText(table: JsonRecord): string {
  return asArray(table["tableRows"])
    .map((row) =>
      asArray(asRecord(row)["tableCells"])
        .map((cell) => textOf(asRecord(cell)["text"]).replace(/[\t\n]+/g, " "))
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
  return [
    a * ca + c * cb,
    b * ca + d * cb,
    a * cc + c * cd,
    b * cc + d * cd,
    a * ce + c * cf + e,
    b * ce + d * cf + f,
  ];
}

interface Placed {
  element: JsonRecord;
  x: number;
  y: number;
}

/** Every leaf element of a page, groups opened, at its absolute position. */
function leaves(elements: unknown, parent: Matrix, depth = 0): Placed[] {
  const out: Placed[] = [];
  for (const element of asArray(elements).map(asRecord)) {
    const matrix = compose(parent, matrixOf(element["transform"]));
    const group = asRecord(element["elementGroup"]);
    if (Array.isArray(group["children"]) && depth < 20) {
      out.push(...leaves(group["children"], matrix, depth + 1));
    } else {
      out.push({ element, x: matrix[4], y: matrix[5] });
    }
  }
  return out;
}

type ElementKind = "shape" | "table" | "wordArt" | "image" | "video" | "chart" | "other";

function kindOf(element: JsonRecord): ElementKind | "line" {
  if (element["shape"]) return "shape";
  if (element["table"]) return "table";
  if (element["wordArt"]) return "wordArt";
  if (element["image"]) return "image";
  if (element["video"]) return "video";
  if (element["sheetsChart"]) return "chart";
  if (element["line"]) return "line";
  return "other";
}

/** Why text was cut, as the marker tells the reader. */
const RAISE_CAP = "raise maxCharsPerSlide to read them";
const OVER_RESULT = "this slide is larger than one result can carry";

/** Cut `value` at `max` characters and say so, and why, in the text itself. */
function capped(value: string, max: number, why = RAISE_CAP): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  const head = headOf(value, max);
  return {
    text: `${head}\n[… ${value.length - head.length} more characters truncated; ${why}]`,
    truncated: true,
  };
}

/** The first `max` UTF-16 units of `value`, never ending half a surrogate pair. */
function headOf(value: string, max: number): string {
  const code = value.charCodeAt(max - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** UTF-8 bytes of a value as JSON: what the bridge and the stash measure. */
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

const TITLE_PLACEHOLDERS = new Set(["TITLE", "CENTERED_TITLE"]);

interface SlideProjection {
  slide: JsonRecord;
  truncated: boolean;
}

function projectSlide(
  value: unknown,
  index: number,
  layouts: ReadonlyMap<string, string>,
  maxChars: number,
  why = RAISE_CAP,
): SlideProjection {
  const slide = asRecord(value);
  const properties = asRecord(slide["slideProperties"]);
  // Reading order: top to bottom, then left to right, by absolute position
  // rounded to the point, so a hairline offset does not reorder a row.
  const placed = leaves(slide["pageElements"], IDENTITY).sort(
    (left, right) =>
      Math.round(left.y / EMU_PER_PT) - Math.round(right.y / EMU_PER_PT) ||
      Math.round(left.x / EMU_PER_PT) - Math.round(right.x / EMU_PER_PT),
  );
  let budget = maxChars;
  let truncated = false;
  let omitted = 0;
  let title: string | undefined;
  const elements: JsonRecord[] = [];
  for (const { element } of placed) {
    const kind = kindOf(element);
    const shape = asRecord(element["shape"]);
    const placeholder = text(asRecord(shape["placeholder"])["type"]);
    const full =
      kind === "shape"
        ? textOf(shape["text"])
        : kind === "table"
          ? tableText(asRecord(element["table"]))
          : kind === "wordArt"
            ? (text(asRecord(element["wordArt"])["renderedText"]) ?? "")
            : "";
    const alt = [text(element["title"]), text(element["description"])].filter(Boolean).join(": ");
    // Decorative lines and empty boxes carry nothing to read; they are
    // counted, not listed. An empty placeholder is kept: its id is where
    // insertText fills a new slide's title or body.
    if (kind === "line" || (!full && !alt && !placeholder && (kind === "shape" || kind === "wordArt"))) {
      omitted += 1;
      continue;
    }
    if (placeholder && TITLE_PLACEHOLDERS.has(placeholder) && title === undefined && full) {
      title = capped(full.replace(/\n+/g, " "), Math.min(MAX_TITLE_CHARS, maxChars), why).text;
    }
    const altCut = alt ? capped(alt, Math.min(MAX_ALT_TEXT_CHARS, maxChars), why) : undefined;
    const altText = altCut?.text;
    truncated ||= altCut?.truncated ?? false;
    const cut = full ? capped(full, Math.max(budget, 0), why) : { text: undefined, truncated: false };
    if (full) budget -= Math.min(full.length, Math.max(budget, 0));
    truncated ||= cut.truncated;
    elements.push(
      compact({
        objectId: text(element["objectId"]),
        kind,
        placeholder,
        text: cut.text,
        altText,
        // A linked chart's data lives in Sheets; the id is how to reach it.
        spreadsheetId: kind === "chart" ? text(asRecord(element["sheetsChart"])["spreadsheetId"]) : undefined,
        truncated: cut.truncated || undefined,
      }),
    );
  }
  const notesPage = asRecord(properties["notesPage"]);
  const notesId = text(asRecord(notesPage["notesProperties"])["speakerNotesObjectId"]);
  const notesShape = asArray(notesPage["pageElements"])
    .map(asRecord)
    .find((element) => notesId !== undefined && element["objectId"] === notesId);
  const notesText = notesShape ? textOf(asRecord(notesShape["shape"])["text"]) : "";
  const notes = notesText ? capped(notesText, maxChars, why) : undefined;
  truncated ||= notes?.truncated ?? false;
  const layoutId = text(properties["layoutObjectId"]);
  return {
    slide: compact({
      objectId: text(slide["objectId"]),
      index,
      layout: layoutId ? layouts.get(layoutId) : undefined,
      layoutId,
      skipped: properties["isSkipped"] === true || undefined,
      title,
      elements,
      omittedElements: omitted > 0 ? omitted : undefined,
      notes: notes?.text,
      truncated: truncated || undefined,
    }),
    truncated,
  };
}

/**
 * A slide too large for the `room` a page has left, made to fit: its text
 * halved until it does, and, for a slide of so many elements that it does not
 * fit even with no text, its last elements left out and counted. Only a
 * page's first slide is fitted; a later one that does not fit starts the next
 * page whole. Every cut says it was the result's size, not maxCharsPerSlide.
 */
function fitSlide(
  value: unknown,
  index: number,
  layouts: ReadonlyMap<string, string>,
  maxChars: number,
  room: number,
): JsonRecord {
  for (let chars = Math.floor(maxChars / 2); ; chars = Math.floor(chars / 2)) {
    const { slide } = projectSlide(value, index, layouts, chars, OVER_RESULT);
    if (jsonBytes(slide) <= room) return slide;
    if (chars > 0) continue;
    const elements = asArray(slide["elements"]);
    const keeping = (count: number) => ({
      ...slide,
      elements: elements.slice(0, count),
      elementsNotShown: elements.length - count,
      truncated: true,
    });
    let low = 0;
    let high = elements.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (jsonBytes(keeping(middle)) <= room) low = middle;
      else high = middle - 1;
    }
    return keeping(low);
  }
}

/** A raw slide no result can carry, named and measured in its place. */
function rawNotShown(value: unknown, bytes: number): JsonRecord {
  return compact({
    objectId: text(asRecord(value)["objectId"]),
    rawNotShown: `This slide's raw JSON is ${bytes} bytes, more than one result can carry. Read it without raw for its text.`,
  });
}

/**
 * The deck's layouts for create_slide, bounded in bytes: a deck with many
 * masters carries many layouts, and the list rides on a result's first page.
 */
function layoutList(presentation: JsonRecord): { layouts: JsonRecord[]; notShown: number } {
  const all = asArray(presentation["layouts"]).map((value) => {
    const layout = asRecord(value);
    const properties = asRecord(layout["layoutProperties"]);
    return compact({
      objectId: text(layout["objectId"]),
      name: text(properties["name"]),
      displayName: text(properties["displayName"]),
    });
  });
  const layouts: JsonRecord[] = [];
  let used = 2;
  for (const layout of all) {
    used += jsonBytes(layout) + 1;
    if (used > MAX_LAYOUT_BYTES) break;
    layouts.push(layout);
  }
  return { layouts, notShown: all.length - layouts.length };
}

/** A layout's name as a person picks it: its display name, else its kind. */
function layoutNames(presentation: JsonRecord): Map<string, string> {
  const names = new Map<string, string>();
  for (const layout of asArray(presentation["layouts"]).map(asRecord)) {
    const id = text(layout["objectId"]);
    const properties = asRecord(layout["layoutProperties"]);
    const name = text(properties["displayName"]) ?? text(properties["name"]);
    if (id && name) names.set(id, name);
  }
  return names;
}

function dimension(value: unknown): { magnitude: number; unit: string } | undefined {
  const record = asRecord(value);
  return typeof record["magnitude"] === "number"
    ? { magnitude: record["magnitude"], unit: text(record["unit"]) ?? "EMU" }
    : undefined;
}

/** The cursor get_presentation pages with: the next slide's index, opaque. */
const CURSOR_PREFIX = "slide:";

function cursorStart(cursor: unknown): number {
  if (cursor === undefined) return 0;
  const match = new RegExp(`^${CURSOR_PREFIX}(\\d{1,6})$`).exec(String(cursor));
  if (!match) {
    throw new ConnectorCallError(
      "invalid_args",
      "cursor is not a page.nextCursor this connection returned; pass it back unchanged, or omit it for the first page.",
    );
  }
  return Number(match[1]);
}

// --- Writing ----------------------------------------------------------------------

/**
 * One batchUpdate. A write that names `requiredRevisionId` is revision
 * guarded: the shared layer turns Slides' precondition refusal into a
 * `conflict`, so a deck someone changed since the read is re-read, not
 * retried. Nothing was applied either way — a batch is all or none.
 */
async function batchUpdate(
  client: GoogleWorkspaceClient,
  ctx: ConnectorContext,
  presentationId: string,
  requests: unknown[],
  requiredRevisionId?: string,
): Promise<JsonRecord> {
  return asRecord(
    await client.json(
      {
        method: "POST",
        path: `/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
        body: compact({
          requests,
          writeControl: requiredRevisionId === undefined ? undefined : { requiredRevisionId },
        }),
      },
      ctx,
      { revisionGuarded: requiredRevisionId !== undefined },
    ),
  );
}

/** The revision a write left the deck at, for the next write to name. */
function revisionAfter(response: JsonRecord): string | undefined {
  return text(asRecord(response["writeControl"])["requiredRevisionId"]);
}

// --- Schemas ----------------------------------------------------------------------

function input(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const PRESENTATION_ID: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9_-]+$",
  description: "Presentation id: the part after /presentation/d/ in its URL, or from Drive.",
};

/** Slides object ids: a word character, then word characters, `-`, or `:`. */
function objectIdProperty(description: string): JsonSchema {
  return { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_][A-Za-z0-9_:-]*$", description };
}

const REVISION_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: "^[^\\s]+$",
  description: "revisionId from get_presentation; the write is refused, unapplied, if the deck changed since.",
};

const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hasMore: { type: "boolean" },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["hasMore", "nextCursor"],
};

const DIMENSION_SCHEMA: JsonSchema = {
  type: "object",
  properties: { magnitude: { type: "number" }, unit: { type: "string" } },
};

const ELEMENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    objectId: { type: "string" },
    kind: { type: "string", enum: ["shape", "table", "wordArt", "image", "video", "chart", "other"] },
    placeholder: { type: "string" },
    text: { type: "string" },
    altText: { type: "string" },
    spreadsheetId: { type: "string" },
    truncated: { type: "boolean" },
  },
};

const SLIDE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    objectId: { type: "string" },
    index: { type: "integer" },
    layout: { type: "string" },
    layoutId: { type: "string" },
    skipped: { type: "boolean" },
    title: { type: "string" },
    elements: { type: "array", items: ELEMENT_SCHEMA },
    omittedElements: { type: "integer" },
    elementsNotShown: { type: "integer" },
    notes: { type: "string" },
    truncated: { type: "boolean" },
    rawNotShown: { type: "string" },
  },
};

const WRITE_RESULT_PROPERTIES: Record<string, JsonSchema> = {
  presentationId: { type: "string" },
  revisionId: { type: "string" },
};

// --- Tools ------------------------------------------------------------------------

function tools(client: GoogleWorkspaceClient): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;

  return [
    {
      name: "get_presentation",
      description:
        "Read a Google Slides deck: title, page size, revisionId, layouts, and each slide's text in reading order with speaker notes, capped per slide. Cannot find decks; that is Drive's job.",
      annotations: readOnly,
      inputSchema: input(
        {
          presentationId: PRESENTATION_ID,
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_PAGE_SIZE,
            description: `Slides per page, 1 to ${MAX_PAGE_SIZE}; defaults to ${DEFAULT_PAGE_SIZE}. Connecta's paging, which also ends a page before ~192 KB.`,
          },
          cursor: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            description: "Opaque page.nextCursor from the previous page. Pass it back unchanged.",
          },
          maxCharsPerSlide: {
            type: "integer",
            minimum: 0,
            maximum: MAX_SLIDE_CHARS,
            description: `Text kept per slide (notes apart), 0 to ${MAX_SLIDE_CHARS}; defaults to ${DEFAULT_SLIDE_CHARS}. Cut text ends with a marker.`,
          },
          raw: {
            type: "boolean",
            description: "Return this page's slides as Slides sends them, every style and transform, in place of the projection. No layouts or masters.",
          },
        },
        ["presentationId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          presentationId: { type: "string" },
          title: { type: "string" },
          revisionId: { type: "string" },
          url: { type: "string" },
          locale: { type: "string" },
          pageSize: {
            type: "object",
            properties: { width: DIMENSION_SCHEMA, height: DIMENSION_SCHEMA },
          },
          slideCount: { type: "integer" },
          layouts: {
            type: "array",
            items: {
              type: "object",
              properties: { objectId: { type: "string" }, name: { type: "string" }, displayName: { type: "string" } },
            },
          },
          layoutsNotShown: { type: "integer" },
          slides: { type: "array", items: SLIDE_SCHEMA },
          page: PAGE_SCHEMA,
        },
        // ProtoJSON drops empty arrays, and `raw: true` passes Slides' own
        // slide objects through, so only what connecta always sets is required.
        required: ["presentationId", "slides", "page"],
      },
      handler: async (args, ctx) => {
        const start = cursorStart(args["cursor"]);
        const raw = args["raw"] === true;
        const presentation = asRecord(
          await client.json(
            {
              method: "GET",
              path: `/presentations/${encodeURIComponent(args["presentationId"])}`,
              query: { fields: raw ? undefined : PRESENTATION_FIELDS },
            },
            ctx,
          ),
        );
        const all = asArray(presentation["slides"]);
        const limit = typeof args["limit"] === "number" ? args["limit"] : DEFAULT_PAGE_SIZE;
        const maxChars = typeof args["maxCharsPerSlide"] === "number" ? args["maxCharsPerSlide"] : DEFAULT_SLIDE_CHARS;
        const layouts = layoutNames(presentation);
        const id = text(presentation["presentationId"]) ?? args["presentationId"];
        const pageSize = asRecord(presentation["pageSize"]);
        const width = dimension(pageSize["width"]);
        const height = dimension(pageSize["height"]);
        const title = text(presentation["title"]);
        const listed = start === 0 && !raw ? layoutList(presentation) : undefined;
        const header = compact({
          presentationId: id,
          title: title ? capped(title, MAX_TITLE_CHARS, "the title is longer than this connection returns").text : undefined,
          // Only an account that may edit the deck is given one.
          revisionId: text(presentation["revisionId"]),
          url: editUrl(id),
          locale: text(presentation["locale"]),
          pageSize: width && height ? { width, height } : undefined,
          slideCount: all.length,
          layouts: listed?.layouts,
          layoutsNotShown: listed?.notShown || undefined,
        });
        // A page ends at the slide limit or at the byte budget, whichever is
        // first, so it is always one deliverable result: the budget counts
        // the header and the largest page object it could carry.
        let used = jsonBytes({ ...header, slides: [], page: { hasMore: true, nextCursor: `${CURSOR_PREFIX}999999` } });
        const slides: JsonRecord[] = [];
        let next = start;
        while (next < all.length && slides.length < limit) {
          const room = MAX_RESULT_BYTES - used - 1;
          let slide = raw ? asRecord(all[next]) : projectSlide(all[next], next, layouts, maxChars).slide;
          let size = jsonBytes(slide);
          if (size > room) {
            if (slides.length > 0) break;
            slide = raw ? rawNotShown(all[next], size) : fitSlide(all[next], next, layouts, maxChars, room);
            size = jsonBytes(slide);
          }
          slides.push(slide);
          used += size + 1;
          next += 1;
        }
        const cursor = next < all.length ? `${CURSOR_PREFIX}${next}` : null;
        return { ...header, slides, page: { hasMore: cursor !== null, nextCursor: cursor } };
      },
    },
    {
      name: "get_slide_thumbnail",
      description:
        "Get a PNG thumbnail link for one slide: a URL valid about 30 minutes that opens as the user, plus its size. Never downloads the image.",
      annotations: readOnly,
      inputSchema: input(
        {
          presentationId: PRESENTATION_ID,
          slideObjectId: objectIdProperty("Slide objectId from get_presentation."),
          size: {
            type: "string",
            enum: ["SMALL", "MEDIUM", "LARGE", "WIDTH2000_PX"],
            description: "Width: SMALL 200px, MEDIUM 800px, LARGE 1600px, WIDTH2000_PX 2000px; Slides chooses when omitted.",
          },
        },
        ["presentationId", "slideObjectId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          contentUrl: { type: "string" },
          width: { type: "integer" },
          height: { type: "integer" },
        },
        required: ["contentUrl"],
      },
      handler: async (args, ctx) => {
        const thumbnail = asRecord(
          await client.json(
            {
              method: "GET",
              path: `/presentations/${encodeURIComponent(args["presentationId"])}/pages/${encodeURIComponent(args["slideObjectId"])}/thumbnail`,
              query: {
                "thumbnailProperties.mimeType": "PNG",
                "thumbnailProperties.thumbnailSize": args["size"],
              },
            },
            ctx,
          ),
        );
        return compact({
          contentUrl: text(thumbnail["contentUrl"]) ?? "",
          width: typeof thumbnail["width"] === "number" ? thumbnail["width"] : undefined,
          height: typeof thumbnail["height"] === "number" ? thumbnail["height"] : undefined,
        });
      },
    },
    {
      name: "create_presentation",
      description:
        "Create an empty Google Slides deck with one title slide in the user's My Drive root. It cannot place the deck in a folder or copy a template.",
      // Additive: a new file changes nothing that existed. Not read-only, so
      // it crosses call_destructive_tool unless the deployment exempts it in
      // `execute.approval`; the provider never exempts itself.
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: input(
        {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 1000,
            pattern: "^[^\\r\\n]*$",
            description: "The deck's title, as Drive shows it.",
          },
        },
        ["title"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          ...WRITE_RESULT_PROPERTIES,
          title: { type: "string" },
          url: { type: "string" },
          slideObjectIds: { type: "array", items: { type: "string" } },
        },
        required: ["presentationId"],
      },
      handler: async (args, ctx) => {
        const presentation = asRecord(
          await client.json({ method: "POST", path: "/presentations", body: { title: args["title"] } }, ctx),
        );
        const id = text(presentation["presentationId"]) ?? "";
        return compact({
          presentationId: id,
          revisionId: text(presentation["revisionId"]),
          title: text(presentation["title"]),
          url: id ? editUrl(id) : undefined,
          slideObjectIds: asArray(presentation["slides"])
            .map((slide) => text(asRecord(slide)["objectId"]))
            .filter((value): value is string => value !== undefined),
        });
      },
    },
    {
      name: "create_slide",
      description:
        "Add one empty slide to a deck, from a predefined layout or one of its own layouts, at an index or the end. Adds no text; nothing existing changes.",
      // Additive: later slides move down one place, and nothing is lost.
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: input(
        {
          presentationId: PRESENTATION_ID,
          layout: {
            type: "string",
            enum: [
              "BLANK",
              "CAPTION_ONLY",
              "TITLE",
              "TITLE_AND_BODY",
              "TITLE_AND_TWO_COLUMNS",
              "TITLE_ONLY",
              "SECTION_HEADER",
              "SECTION_TITLE_AND_DESCRIPTION",
              "ONE_COLUMN_TEXT",
              "MAIN_POINT",
              "BIG_NUMBER",
            ],
            description: "Predefined layout; the deck's theme must have it. Omit both layout and layoutId for BLANK.",
          },
          layoutId: objectIdProperty("A layouts[].objectId from get_presentation, instead of layout."),
          insertionIndex: {
            type: "integer",
            minimum: 0,
            maximum: 100_000,
            description: "0-based position, as get_presentation numbers slides; omit to append.",
          },
        },
        ["presentationId"],
      ),
      outputSchema: {
        type: "object",
        properties: { ...WRITE_RESULT_PROPERTIES, slideObjectId: { type: "string" } },
        required: ["presentationId", "slideObjectId"],
      },
      handler: async (args, ctx) => {
        if (args["layout"] !== undefined && args["layoutId"] !== undefined) {
          throw new ConnectorCallError("invalid_args", "Pass layout or layoutId, not both.");
        }
        const reference =
          args["layoutId"] !== undefined
            ? { layoutId: args["layoutId"] }
            : args["layout"] !== undefined
              ? { predefinedLayout: args["layout"] }
              : undefined;
        const response = await batchUpdate(client, ctx, args["presentationId"], [
          { createSlide: compact({ insertionIndex: args["insertionIndex"], slideLayoutReference: reference }) },
        ]);
        return compact({
          presentationId: text(response["presentationId"]) ?? args["presentationId"],
          revisionId: revisionAfter(response),
          slideObjectId: text(asRecord(asRecord(asArray(response["replies"])[0])["createSlide"])["objectId"]) ?? "",
        });
      },
    },
    {
      name: "replace_all_text",
      description:
        "Replace every occurrence of literal text across a deck's slides, or the slides named, in one atomic write. No regex; formatting of the replaced text is kept.",
      // Destructive: the replaced text is gone, everywhere it matched.
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: input(
        {
          presentationId: PRESENTATION_ID,
          replacements: {
            type: "array",
            minItems: 1,
            maxItems: MAX_REPLACEMENTS,
            description: `Applied in order, 1 to ${MAX_REPLACEMENTS} (connecta's bound).`,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["find", "replace"],
              description: "One find-and-replace.",
              properties: {
                find: { type: "string", minLength: 1, maxLength: 1000, description: "Literal text to find." },
                replace: { type: "string", maxLength: 10_000, description: "Replacement; empty deletes the match." },
                matchCase: { type: "boolean", description: "Case-sensitive; defaults to true." },
              },
            },
          },
          slideObjectIds: {
            type: "array",
            minItems: 1,
            maxItems: 500,
            items: objectIdProperty("A slide objectId."),
            description: "Limit to these slides; omit for every slide.",
          },
          requiredRevisionId: REVISION_PROPERTY,
        },
        ["presentationId", "replacements"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          ...WRITE_RESULT_PROPERTIES,
          occurrencesChanged: { type: "integer" },
          replacements: {
            type: "array",
            items: {
              type: "object",
              properties: { find: { type: "string" }, occurrencesChanged: { type: "integer" } },
            },
          },
        },
        required: ["presentationId", "occurrencesChanged", "replacements"],
      },
      handler: async (args, ctx) => {
        const replacements = asArray(args["replacements"]).map(asRecord);
        const response = await batchUpdate(
          client,
          ctx,
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
        return compact({
          presentationId: text(response["presentationId"]) ?? args["presentationId"],
          revisionId: revisionAfter(response),
          occurrencesChanged: counted.reduce((sum, entry) => sum + entry.occurrencesChanged, 0),
          replacements: counted,
        });
      },
    },
    {
      name: "batch_update_presentation",
      description:
        "Send raw Slides batchUpdate requests to a deck, atomically, at the revision it was read at. Always destructive; prefer the named tools when one fits.",
      // Destructive: a raw request can delete or overwrite anything in the deck.
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: input(
        {
          presentationId: PRESENTATION_ID,
          requiredRevisionId: REVISION_PROPERTY,
          requests: {
            type: "array",
            minItems: 1,
            maxItems: MAX_BATCH_REQUESTS,
            description: `Slides Request objects, applied in order, all or none; 1 to ${MAX_BATCH_REQUESTS} (connecta's bound).`,
            items: {
              type: "object",
              minProperties: 1,
              maxProperties: 1,
              description: 'One Request with one key, as the Slides reference defines it: {"insertText": {...}}.',
            },
          },
        },
        ["presentationId", "requiredRevisionId", "requests"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          ...WRITE_RESULT_PROPERTIES,
          replies: { type: "array", items: { type: "object" } },
        },
        required: ["presentationId", "replies"],
      },
      handler: async (args, ctx) => {
        const requests = asArray(args["requests"]);
        const unknown = requests
          .map((request, index) => [index, Object.keys(asRecord(request))[0] ?? ""] as const)
          .filter(([, kind]) => !REQUEST_KINDS.has(kind));
        if (unknown.length > 0) {
          throw new ConnectorCallError(
            "invalid_args",
            `Not a Slides request kind: ${unknown
              .slice(0, 5)
              .map(([index, kind]) => `requests[${index}] "${kind.slice(0, 64)}"`)
              .join(", ")}. Each request is one of Slides' Request kinds, such as insertText, deleteObject, or createShape; nothing was sent.`,
          );
        }
        const response = await batchUpdate(
          client,
          ctx,
          args["presentationId"],
          requests,
          args["requiredRevisionId"],
        );
        return compact({
          presentationId: text(response["presentationId"]) ?? args["presentationId"],
          revisionId: revisionAfter(response),
          // One per request, in order; most are empty, the create replies
          // carry the new object ids.
          replies: asArray(response["replies"]).map(asRecord),
        });
      },
    },
  ];
}

// --- Guide ------------------------------------------------------------------------

function usageGuide(purpose: string, instructions: string | undefined): string {
  const extra = instructions?.trim();
  return `# Google Slides usage

Acts as the signed-in person in Google Slides through Workspace delegation: read, create, and edit the decks they can open.

Connection purpose: ${purpose}

## Whose decks

Every call acts as the Workspace account deployment config maps the caller
to, and reaches exactly the decks that person can open. No argument names an
account. A call with none mapped fails \`auth_required\`; only an operator can
change the mapping. A deck the person cannot see and one that does not exist
fail alike — Google does not say which.

## Finding a deck

Slides cannot list or search decks; that is Google Drive's job. Take the id
from a Drive search or from a URL (\`/presentation/d/<id>/\`).

## Reading

- \`get_presentation\` returns each slide's text in reading order (top to
  bottom, then left to right), speaker notes, and alt text for images,
  videos, and charts. Empty placeholders are listed with their id and type,
  so a new slide's title and body can be filled; lines and other empty
  shapes are counted in \`omittedElements\`. Text past \`maxCharsPerSlide\`
  ends with a truncation marker. Page with \`page.nextCursor\`; each page
  re-reads the deck, and only the first lists \`layouts\`.
- A page also ends before it outgrows one result (about 192 KB), so it may
  hold fewer slides than \`limit\`. A single slide too large for one result
  is cut to fit, and its markers say so; raising \`maxCharsPerSlide\` will
  not bring that text back.
- Styles, positions, and image links are left out. \`raw: true\` returns
  this page's slides as Slides sends them, without layouts or masters; a
  slide whose raw JSON is too large for any result is named in
  \`rawNotShown\` instead.
- \`index\` is 0-based, the same numbering \`create_slide\` takes.
- \`get_slide_thumbnail\` returns a link, never the image. The link opens as
  this person for about 30 minutes; do not share it.

## Writing

- \`create_presentation\` and \`create_slide\` are additive. A new slide is
  empty: fill it with \`batch_update_presentation\` (\`insertText\` into its
  placeholders, after reading their ids with \`get_presentation\`).
- \`replace_all_text\` changes every literal match, case-sensitive unless
  \`matchCase: false\`. Pass \`requiredRevisionId\` to refuse a deck that
  changed since you read it.
- \`batch_update_presentation\` takes Slides' own Request objects and always
  requires the \`revisionId\` from the read the requests were built on. All
  requests apply or none do. Each write returns the new \`revisionId\` for the
  next one. A \`conflict\` means the deck changed since that read: re-read it,
  rebuild the requests, and send them with the new \`revisionId\`.
- Nothing here shares, moves, or deletes a deck.
${extra ? `\n## Connection instructions\n\n${extra}\n` : ""}`;
}

// --- Construction -----------------------------------------------------------------

/**
 * A maintained Google Slides connection acting as each signed-in Workspace
 * user through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Slides API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches users' decks.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation. Add the client
 *    ID, or edit its existing entry, so its scopes include exactly this one
 *    ({@link SLIDES_SCOPES}):
 *    `https://www.googleapis.com/auth/presentations`. One entry carries every
 *    Workspace provider's scopes, comma-separated. A new grant can take up to
 *    24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * slides("decks", {
 *   purpose: "Sermon slides and staff meeting decks",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * Reads run in programs. `create_presentation` and `create_slide` are additive
 * writes the host approves unless the deployment exempts them in
 * `execute.approval`; `replace_all_text` and `batch_update_presentation` are
 * destructive.
 */
export function slides(id: string, options: SlidesOptions): Connector {
  const connection = workspaceConnection("slides", options);
  const client = googleWorkspaceClient({
    provider: "Google Slides",
    api: "Google Slides API",
    baseUrl: options.baseUrl?.trim() || SLIDES_API_BASE_URL,
    scopes: SLIDES_SCOPES,
    maxResponseBytes: SLIDES_MAX_RESPONSE_BYTES,
    // A deck is a Drive file: a 404 is the same answer for one that does not
    // exist and one this account may not open.
    notFound: "ambiguous",
    connection,
  });
  return api(id, {
    ...defined({
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
    title: options.title ?? "Google Slides",
    description: `Google Slides as the signed-in Workspace user: read decks slide by slide, create them, and edit their text — ${connection.purpose}`,
    usageGuide: {
      content: usageGuide(connection.purpose, options.instructions),
      summary: "Each caller's own decks: per-slide text and notes, new decks and slides, text replacement, raw batchUpdate.",
      // Required: whose decks they are, that listing is Drive's, and the
      // revision discipline on writes are conventions no schema can carry.
      required: true,
    },
    tools: tools(client),
  });
}
