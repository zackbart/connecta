import { asRecord, asArray, compact } from "../_shared/json.js";
// Google Docs named projections and bounded writes over the provider kit.
import { Effect, Option, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { canonicalJson } from "../../canonical-json.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure } from "../../http/errors.js";
import { fieldsProblem, selectFields } from "../../http/fields.js";
import { Recovery, type CallServices } from "../../http/services.js";
import type { Connection } from "../../http/vendor.js";
import { requestSentSecrets, redactBeforeCut } from "../../sent-secrets.js";
import type { ConnectorContext } from "../../types.js";
import { providerCallFailure } from "../../write-outcome.js";
import { googleClient, googleFailureMessage, googleOutcomeOf, type GoogleClient } from "../_shared/google/kit.js";
import { RESULT_BUDGET_BYTES, clampText, jsonBytes } from "../_shared/google/result-size.js";
import { DOCS_INDEX } from "./lib/discovery.js";
import { Operation } from "../../runtime/call.js";
import { boundCursor } from "../../http/paging.js";
import { read, write } from "../../http/tools.js";
import * as schemas from "./lib/schemas.js";

/**
 * Rendered characters kept across a document's tabs by default: at most about
 * 60 KB of JSON even in a three-byte script, so a default read crosses the
 * 256 KiB execute_code bridge with room for its index page and tab rows.
 */
const DEFAULT_MAX_CHARS = 20_000;
/**
 * Serialized bytes of index rows in one page. Rows are a few hundred bytes at
 * most, so a page is hundreds of them; a long document pages by cursor rather
 * than returning more than the execute_code bridge carries.
 */
const ELEMENT_PAGE_BYTES = 64 * 1024;
/** Characters of each index row's text preview. */
const PREVIEW_CHARS = 80;
type JsonRecord = Record<string, any>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * Ids Google sends back are copied into results only if a tool could take
 * them as input again — the same pattern and length the input schemas
 * enforce. Anything else is dropped whole and named in the result's
 * `dropped`, never cut: a shortened id addresses something else.
 */
const ID_RULES = {
  documentId: { pattern: /^[A-Za-z0-9_-]+$/, max: 256 },
  revisionId: { pattern: /^\S+$/, max: 512 },
  tabId: { pattern: /^[A-Za-z0-9._-]+$/, max: 128 },
} as const;

function keptId(value: unknown, kind: keyof typeof ID_RULES, name: string, dropped: string[]): string | undefined {
  const id = text(value);
  if (id === undefined) return undefined;
  const rule = ID_RULES[kind];
  if (id.length <= rule.max && rule.pattern.test(id)) return id;
  dropped.push(name);
  return undefined;
}

/** Titles are prose: cut to this many JSON bytes with a marker, never dropped. */
const TITLE_BYTES = 4 * 1024;

function boundedTitle(ctx: ConnectorContext, value: unknown): string | undefined {
  const title = text(value);
  return title === undefined ? undefined : clampText(ctx, title, TITLE_BYTES, (more) => `… [${more} more characters]`);
}

function droppedField(dropped: string[]): string[] | undefined {
  return dropped.length > 0 ? [...new Set(dropped)].slice(0, 20) : undefined;
}

function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/edit`;
}

// --- Rendering a document ----------------------------------------------------------

/** What one tab's rendering needs from around its body. */
interface TabSources {
  lists: JsonRecord;
  footnotes: JsonRecord;
  inlineObjects: JsonRecord;
}

/** One index row: where a block sits, so an edit can target it. */
interface IndexRow {
  type: "paragraph" | "table" | "table_of_contents";
  startIndex: number;
  endIndex: number;
  style?: string | undefined;
  row?: number | undefined;
  column?: number | undefined;
  text?: string | undefined;
  previewCut?: boolean | undefined;
}

interface RenderState {
  /** The call, whose sent secrets a preview replaces before it cuts. */
  ctx: ConnectorContext;
  sources: TabSources;
  /** Footnotes in the order the body first references them. */
  footnotes: { id: string; number: string }[];
  /** Index rows, collected only when asked for. */
  rows: IndexRow[] | undefined;
  marks: Marks;
}

/** What a rendering noticed it could not show, shared with its footnotes. */
interface Marks {
  /** Rendered text includes a suggested insertion or deletion, unmarked. */
  suggested: boolean;
  /** An element of a kind this rendering does not know was skipped. */
  unknown: boolean;
}

/**
 * What a tab holds that its text does not show, named so a reader never
 * mistakes the rendering for the whole document: headers, footers, floating
 * (positioned) images, in the inline view which text is a suggestion, and any
 * element of a kind Google added after this rendering was written. Every
 * paragraph element kind Docs v1 defines renders as something.
 */
const NOT_RENDERED = ["headers", "footers", "positioned_objects", "suggestion_marks", "unknown_elements"] as const;

const AUTO_TEXT: Readonly<Record<string, string>> = {
  PAGE_NUMBER: "[page number]",
  PAGE_COUNT: "[page count]",
};

function suggested(part: JsonRecord): boolean {
  return asArray(part["suggestedInsertionIds"]).length > 0 || asArray(part["suggestedDeletionIds"]).length > 0;
}

const HEADINGS: Readonly<Record<string, string>> = {
  TITLE: "# ",
  SUBTITLE: "## ",
  HEADING_1: "# ",
  HEADING_2: "## ",
  HEADING_3: "### ",
  HEADING_4: "#### ",
  HEADING_5: "##### ",
  HEADING_6: "###### ",
};

/** Whether a list level numbers its items, from the tab's list definitions. */
function ordered(sources: TabSources, bullet: JsonRecord): boolean {
  const list = asRecord(sources.lists[String(bullet["listId"] ?? "")]);
  const levels = asArray(asRecord(list["listProperties"])["nestingLevels"]);
  const level = asRecord(levels[integer(bullet["nestingLevel"]) ?? 0]);
  const glyph = text(level["glyphType"]);
  return glyph !== undefined && glyph !== "NONE" && glyph !== "GLYPH_TYPE_UNSPECIFIED";
}

/**
 * One paragraph element as text: a run's content, a link's text and target,
 * a person's name, a rich link's title, and a bracketed marker for what has
 * no text of its own.
 */
function elementText(element: JsonRecord, state: RenderState): { text: string; url?: string } {
  for (const part of Object.values(element)) {
    if (part && typeof part === "object" && suggested(asRecord(part))) state.marks.suggested = true;
  }
  const run = asRecord(element["textRun"]);
  if (typeof run["content"] === "string") {
    const url = text(asRecord(asRecord(run["textStyle"])["link"])["url"]);
    return url ? { text: run["content"], url } : { text: run["content"] };
  }
  if (element["person"]) {
    const person = asRecord(asRecord(element["person"])["personProperties"]);
    return { text: text(person["name"]) ?? text(person["email"]) ?? "[person]" };
  }
  if (element["richLink"]) {
    const link = asRecord(asRecord(element["richLink"])["richLinkProperties"]);
    const uri = text(link["uri"]);
    const title = text(link["title"]) ?? uri ?? "link";
    return uri ? { text: title, url: uri } : { text: title };
  }
  if (element["footnoteReference"]) {
    const reference = asRecord(element["footnoteReference"]);
    const id = text(reference["footnoteId"]);
    const number = text(reference["footnoteNumber"]) ?? String(state.footnotes.length + 1);
    if (id && !state.footnotes.some((entry) => entry.id === id)) state.footnotes.push({ id, number });
    return { text: `[^${number}]` };
  }
  if (element["inlineObjectElement"]) {
    const id = String(asRecord(element["inlineObjectElement"])["inlineObjectId"] ?? "");
    const embedded = asRecord(
      asRecord(asRecord(state.sources.inlineObjects[id])["inlineObjectProperties"])["embeddedObject"],
    );
    const label = text(embedded["title"]) ?? text(embedded["description"]);
    return { text: label ? `[image: ${label}]` : "[image]" };
  }
  if (element["dateElement"]) {
    const date = asRecord(asRecord(element["dateElement"])["dateElementProperties"]);
    return { text: text(date["displayText"]) ?? "[date]" };
  }
  if (element["dropdown"]) {
    const dropdown = asRecord(asRecord(element["dropdown"])["dropdownProperties"]);
    return { text: text(dropdown["displayValue"]) ?? "[dropdown: no selection]" };
  }
  if (element["autoText"]) {
    return { text: AUTO_TEXT[String(asRecord(element["autoText"])["type"] ?? "")] ?? "[auto text]" };
  }
  if (element["horizontalRule"]) return { text: "---" };
  // The API exposes no equation content, only that one is there.
  if (element["equation"]) return { text: "[equation]" };
  if (element["pageBreak"]) return { text: "[page break]" };
  if (element["columnBreak"]) return { text: "[column break]" };
  if (Object.keys(element).some((key) => key !== "startIndex" && key !== "endIndex")) {
    state.marks.unknown = true;
  }
  return { text: "" };
}

/** Docs' soft line break (Shift+Enter) inside one paragraph. */
const VERTICAL_TAB = String.fromCharCode(0x0b);

/**
 * A paragraph's text with its links as `[text](url)`. Adjacent runs that
 * share a link become one link, and the paragraph's own closing newline is
 * dropped; a soft line break (U+000B) becomes a newline.
 */
function paragraphText(paragraph: JsonRecord, state: RenderState): string {
  const pieces: { text: string; url?: string }[] = [];
  for (const element of asArray(paragraph["elements"])) {
    const piece = elementText(asRecord(element), state);
    const last = pieces[pieces.length - 1];
    if (last && last.url === piece.url) last.text += piece.text;
    else pieces.push(piece);
  }
  const safe = requestSentSecrets(state.ctx).parts(pieces.map((piece) => piece.text));
  for (const [index, piece] of pieces.entries()) {
    piece.text = safe[index]!;
    if (piece.url) piece.url = redactBeforeCut(state.ctx, piece.url);
  }
  const lastPiece = pieces[pieces.length - 1];
  if (lastPiece) lastPiece.text = lastPiece.text.replace(/\n$/, "");
  return pieces
    .map((piece) => (piece.url && piece.text.trim() ? `[${piece.text}](${piece.url})` : piece.text))
    .join("")
    .replaceAll(VERTICAL_TAB, "\n");
}

/** Where to cut `value` near `max` UTF-16 units without splitting a surrogate pair. */
function safeCut(value: string, max: number): number {
  const code = value.charCodeAt(max - 1);
  return max > 0 && code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
}

function preview(ctx: ConnectorContext, value: string): { text: string; cut: boolean } {
  // Collapsing whitespace can join a value that spans lines, so the flat text is checked too.
  const flat = redactBeforeCut(ctx, redactBeforeCut(ctx, value).replace(/\s+/g, " ").trim());
  return {
    text: flat.length > PREVIEW_CHARS ? `${flat.slice(0, safeCut(flat, PREVIEW_CHARS))}…` : flat,
    cut: flat.length > PREVIEW_CHARS,
  };
}

/** Render structural elements as markdown-ish lines, collecting index rows. */
function renderContent(content: unknown, state: RenderState, cell?: { row: number; column: number }): string[] {
  const lines: string[] = [];
  for (const value of asArray(content)) {
    const element = asRecord(value);
    const start = integer(element["startIndex"]) ?? 0;
    const end = integer(element["endIndex"]) ?? start;
    if (element["paragraph"]) {
      const paragraph = asRecord(element["paragraph"]);
      const style = text(asRecord(paragraph["paragraphStyle"])["namedStyleType"]);
      const body = paragraphText(paragraph, state);
      const bullet = paragraph["bullet"] ? asRecord(paragraph["bullet"]) : undefined;
      let prefix = "";
      if (bullet) {
        prefix = `${"  ".repeat(integer(bullet["nestingLevel"]) ?? 0)}${ordered(state.sources, bullet) ? "1." : "-"} `;
      } else if (style && HEADINGS[style] && body.trim()) {
        prefix = HEADINGS[style]!;
      }
      lines.push(`${prefix}${body}`);
      const peek = preview(state.ctx, body);
      state.rows?.push(
        compact({
          type: "paragraph" as const,
          startIndex: start,
          endIndex: end,
          style: style && style !== "NORMAL_TEXT" ? style : undefined,
          row: cell?.row,
          column: cell?.column,
          text: peek.text,
          previewCut: peek.cut || undefined,
        }),
      );
    } else if (element["table"]) {
      state.rows?.push(
        compact({ type: "table" as const, startIndex: start, endIndex: end, row: cell?.row, column: cell?.column }),
      );
      const rows = asArray(asRecord(element["table"])["tableRows"]);
      rows.forEach((rowValue, rowIndex) => {
        const cells = asArray(asRecord(rowValue)["tableCells"]).map((cellValue, columnIndex) =>
          renderContent(asRecord(cellValue)["content"], state, { row: rowIndex, column: columnIndex })
            .join("<br>")
            .replace(/\n/g, "<br>")
            .replace(/\|/g, "\\|")
            .trim(),
        );
        lines.push(`| ${cells.join(" | ")} |`);
        if (rowIndex === 0) lines.push(`|${cells.map(() => " --- |").join("")}`);
      });
    } else if (element["tableOfContents"]) {
      state.rows?.push(compact({ type: "table_of_contents" as const, startIndex: start, endIndex: end }));
      // The headings it lists are rendered where they stand.
      lines.push("[Table of contents]");
    } else if (!element["sectionBreak"] && Object.keys(element).some((key) => !key.endsWith("Index"))) {
      state.marks.unknown = true;
    }
    // A section break has no text and is not an edit target.
  }
  return lines;
}

/** One tab's body as text, with its footnotes after it. */
function renderTab(
  ctx: ConnectorContext,
  tab: JsonRecord,
  sources: TabSources,
  rows: IndexRow[] | undefined,
): { text: string; notRendered: (typeof NOT_RENDERED)[number][] } {
  const marks: Marks = { suggested: false, unknown: false };
  const state: RenderState = { ctx, sources, footnotes: [], rows, marks };
  const lines = renderContent(asRecord(tab["body"])["content"], state);
  const notes = state.footnotes.map(({ id, number }) => {
    const footnote = asRecord(sources.footnotes[id]);
    // Footnote content is its own segment: rendered, never indexed.
    const inner: RenderState = { ctx, sources, footnotes: [], rows: undefined, marks };
    return `[^${number}]: ${renderContent(footnote["content"], inner).join(" ").trim()}`;
  });
  const present = (key: string) => Object.keys(asRecord(tab[key])).length > 0;
  const notRendered = NOT_RENDERED.filter((part) =>
    part === "suggestion_marks"
      ? marks.suggested
      : part === "unknown_elements"
        ? marks.unknown
        : present(part === "positioned_objects" ? "positionedObjects" : part),
  );
  return {
    text: [...lines, ...(notes.length > 0 ? ["", ...notes] : [])]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    notRendered,
  };
}

interface FlatTab {
  tabId: string | undefined;
  title: string | undefined;
  parentTabId: string | undefined;
  nestingLevel: number | undefined;
  documentTab: JsonRecord;
}

/**
 * Every tab, depth first in the order the document shows them. A response
 * without tabs — a document read without `includeTabsContent` — is one
 * untitled tab holding the legacy top-level body.
 */
function flattenTabs(document: JsonRecord): FlatTab[] {
  const tabs: FlatTab[] = [];
  const visit = (value: unknown, depth: number) => {
    const tab = asRecord(value);
    const properties = asRecord(tab["tabProperties"]);
    tabs.push({
      tabId: text(properties["tabId"]),
      title: text(properties["title"]),
      parentTabId: text(properties["parentTabId"]),
      nestingLevel: integer(properties["nestingLevel"]),
      documentTab: asRecord(tab["documentTab"]),
    });
    if (depth > 20) return;
    for (const child of asArray(tab["childTabs"])) visit(child, depth + 1);
  };
  for (const tab of asArray(document["tabs"])) visit(tab, 0);
  if (tabs.length === 0) {
    tabs.push({
      tabId: undefined,
      title: undefined,
      parentTabId: undefined,
      nestingLevel: undefined,
      documentTab: document,
    });
  }
  return tabs;
}

/** The index just past a body's last element: insert before `endIndex - 1`. */
function endIndexOf(body: unknown): number | undefined {
  const content = asArray(asRecord(body)["content"]);
  return integer(asRecord(content[content.length - 1])["endIndex"]);
}

/** Cut text at `max` characters, never inside a surrogate pair, and say so. Every secret the
 * request sent is replaced first: a cut through an echo leaves a fragment nothing redacts. */
function capped(ctx: ConnectorContext, whole: string, max: number): { text: string; textTruncated: boolean } {
  if (whole.length <= max) return { text: whole, textTruncated: false };
  const value = redactBeforeCut(ctx, whole);
  if (value.length <= max) return { text: value, textTruncated: false };
  const cut = safeCut(value, max);
  const rest = value.length - cut;
  return {
    text: `${value.slice(0, cut)}${cut > 0 ? "\n" : ""}[… ${rest} more characters truncated; raise maxChars or pass tabId to read them]`,
    textTruncated: true,
  };
}

const SUGGESTION_MODES: Readonly<Record<string, string>> = {
  inline: "SUGGESTIONS_INLINE",
  accepted: "PREVIEW_SUGGESTIONS_ACCEPTED",
  rejected: "PREVIEW_WITHOUT_SUGGESTIONS",
};

// --- Editing -----------------------------------------------------------------------

function batchPath(documentId: string): string {
  return `/documents/${encodeURIComponent(documentId)}:batchUpdate`;
}

/** The revision a batchUpdate left the document at, when Google reports a usable one. */
function revisionAfter(reply: JsonRecord, dropped: string[]): string | undefined {
  return keptId(asRecord(reply["writeControl"])["requiredRevisionId"], "revisionId", "revisionId", dropped);
}

// No cause: what it would carry is a transport, stream, or parser error that can quote the reply.
function uncertain(message: string, ctx: ConnectorContext): unknown {
  return providerCallFailure(
    ctx,
    { title: "Google Docs" },
    new ConnectorCallError("connector_call_failed", message, { retryable: false }),
    {
      dispatched: true,
      status: 200,
      fallback: "write",
    },
  );
}

/**
 * What a failed write did to the document, from how far the shared client
 * saw the request get (`googleOutcomeOf`) — never from an error code, which
 * the same outcome can arrive under several of.
 *
 * - `not-sent` (`before-send`): nothing left connecta. Nothing happened.
 * - `refused`: Google answered with a 4xx. Nothing applied.
 * - `unknown`: sent, and no status came back (`awaiting-response`), Google
 *   answered a 5xx (`server-error`, whatever reason it carries), Google
 *   redirected (`redirected`, never followed), or Google answered 401 and the
 *   write was not sent again (`unauthorized`). It may or may not have applied.
 * - `probably-applied` (`reading-body`): Google answered 2xx and the reply
 *   could not be used — it broke off, overflowed the ceiling, or would not
 *   parse.
 *
 * "Nothing applied" is claimed only for an observed 4xx (`refused`), never
 * for a write's 5xx — a create or an insert sent twice is two; replaceAllText can match its own
 * replacement; and a revision-guarded batch sent again after its first landed
 * is refused as `conflict`, whose advice to reapply the change would then
 * duplicate it. A failure the client did not classify is `unknown`, the
 * reading that never invites a duplicate.
 */
type WriteOutcome = "not-sent" | "refused" | "unknown" | "probably-applied";

function writeOutcome(error: unknown): WriteOutcome {
  const outcome = googleOutcomeOf(error);
  switch (outcome?.phase) {
    case "before-send":
      return "not-sent";
    case "refused": {
      const status = outcome.status;
      return status !== undefined && status >= 400 && status < 500 ? "refused" : "unknown";
    }
    case "reading-body":
      return "probably-applied";
    case "awaiting-response":
    case "server-error":
    case "redirected":
    case "unauthorized":
    default:
      return "unknown";
  }
}

/**
 * One `documents.batchUpdate`, atomic on Google's side: every request applies
 * or none does. A write naming `requiredRevisionId` is sent revision-guarded,
 * so the shared client reads Google's own reason (FAILED_PRECONDITION or
 * ABORTED on a 400 or 409) and answers a stale revision with `conflict`.
 * Nothing here infers one: a revision read afterwards would prove nothing,
 * since a collaborator may have edited in between. See {@link writeOutcome}
 * for what every other failure means.
 */
function batchUpdate(
  client: GoogleClient,
  documentId: string,
  requests: unknown[],
  requiredRevisionId: string | undefined,
  step?: string,
): Effect.Effect<JsonRecord, HttpFailure, CallServices> {
  return client
    .json(
      {
        method: "POST",
        path: batchPath(documentId),
        template: "/documents/{documentId}:batchUpdate",
        body: compact({ requests, writeControl: requiredRevisionId ? { requiredRevisionId } : undefined }),
      },
      { ...(requiredRevisionId !== undefined ? { revisionGuarded: true } : {}), ...(step ? { step } : {}) },
    )
    .pipe(Effect.map(asRecord));
}

/** Characters of one projected reply string: an id or a short value, never prose. */
const REPLY_STRING_CHARS = 512;

/**
 * One batchUpdate reply kept to what a later request needs: its kind, and
 * the ids and counts beneath it to two levels. A string too long to be an id
 * is dropped whole, never cut into a different one; `truncated` names
 * the projected replies. Most replies are `{}` or one id; this only
 * bites on the rare kind that echoes more.
 */
function projectReply(value: JsonRecord, depth = 0): JsonRecord {
  const kept: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      if (entry.length <= REPLY_STRING_CHARS) kept[key] = entry;
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      kept[key] = entry;
    } else if (entry && typeof entry === "object" && !Array.isArray(entry) && depth < 2) {
      kept[key] = projectReply(entry as JsonRecord, depth + 1);
    }
  }
  return kept;
}

/**
 * A successful batch's result, inside the delivery budget whatever Google
 * echoed. Replies come back whole when they fit; otherwise projected to ids
 * and counts; otherwise the longest prefix that fits, so `replies[i]` still
 * answers `requests[i]`. A cut result still says the batch applied — it did.
 */
function boundedReplies(saved: JsonRecord, replies: JsonRecord[]): JsonRecord {
  const whole = { ...saved, replies };
  if (jsonBytes(whole) <= RESULT_BUDGET_BYTES) return whole;
  const projected = replies.map((reply) => projectReply(reply));
  const slim = { ...saved, replies: projected, truncated: ["replies[]"] };
  const notice = (shown: number) =>
    `The batch applied. ${shown === replies.length ? "Every" : `${shown} of ${replies.length}`} replies ${shown === replies.length ? "is" : "are"} shown, projected to ids and counts, to stay inside the result budget. Do not repeat it; re-read the document with get_document for anything else.`;
  if (jsonBytes({ ...slim, notice: notice(replies.length) }) <= RESULT_BUDGET_BYTES) {
    return { ...slim, notice: notice(replies.length) };
  }
  // The longest prefix whose complete result — its own notice included —
  // fits. JSON adds each element's bytes plus one comma between elements,
  // so a candidate's size is exact without re-serializing it.
  const sizes = projected.map((reply) => jsonBytes(reply));
  const sizeWith = (count: number) =>
    jsonBytes({ ...slim, replies: [], notice: notice(count) }) +
    sizes.slice(0, count).reduce((sum, size) => sum + size, 0) +
    Math.max(0, count - 1);
  let count = 0;
  while (count < projected.length && sizeWith(count + 1) <= RESULT_BUDGET_BYTES) count += 1;
  return { ...slim, replies: projected.slice(0, count), notice: notice(count) };
}

/** An edit's result: the document it addressed, and the revision it left, if usable. */
function savedEdit(documentId: string, reply: JsonRecord): JsonRecord {
  const dropped: string[] = [];
  return compact({ documentId, revisionId: revisionAfter(reply, dropped), dropped: droppedField(dropped) });
}

// --- Tools -------------------------------------------------------------------------

/**
 * Connecta's ceiling on a rendered read: inside the 8 MiB stash a
 * direct call pages from, with room for its envelope.
 */
const MAX_READ_RESULT_BYTES = 4 * 1024 * 1024;

/**
 * The one check every result passes on its way out, whatever built it. The
 * tools bound what they copy, so this is a backstop, not a plan. A read
 * stopped here refuses with its way out; a write was already applied, so it
 * is acknowledged with only its smallest facts and told not to repeat.
 */
function delivered(name: string, args: JsonRecord, result: unknown): unknown {
  const read = name === "get_document";
  // A default read must also cross the execute_code bridge; an explicit
  // maxChars is for a direct call, which the stash pages.
  const explicit = read && args["maxChars"] !== undefined;
  const limit = explicit ? MAX_READ_RESULT_BYTES : RESULT_BUDGET_BYTES;
  const bytes = jsonBytes(result);
  if (bytes <= limit) return result;
  if (read) {
    throw new ConnectorCallError(
      "invalid_args",
      `This document's result is ${bytes} bytes, past connecta's ${limit}-byte ceiling for it. Pass tabId for one tab, or a smaller maxChars.`,
    );
  }
  const full = asRecord(result);
  const small: JsonRecord = {};
  for (const key of ["documentId", "url", "occurrencesChanged"]) {
    const value = full[key];
    if (typeof value === "number" || (typeof value === "string" && value.length <= 1024)) small[key] = value;
  }
  if (name === "batch_update_document") {
    small["replies"] = [];
    small["truncated"] = ["replies[]"];
  }
  small["notice"] =
    `Google Docs applied this ${name === "create_document" ? "create" : "edit"}, but its full result (${bytes} bytes) is too large to return. Do not repeat it; re-read the document with get_document.`;
  return small;
}

export function docsTools({ connection }: { connection: Connection }): ApiTool[] {
  const client = googleClient(connection, DOCS_INDEX);
  return toolDefinitions(connection, client).map((tool) => {
    const isRead = tool.annotations.readOnlyHint === true;
    const spec = {
      name: tool.name,
      description: tool.description,
      input: tool.input,
      output: tool.output,
      ...(tool.writeSteps ? { writeSteps: tool.writeSteps } : {}),
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const fields = isRead ? (args["fields"] as readonly string[] | undefined) : undefined;
          const problem = isRead
            ? fieldsProblem(fields, new Set(Object.keys(schemas.GET_DOCUMENT_OUTPUT.fields)), "the result")
            : undefined;
          if (problem) return yield* Effect.fail(new Refusal({ error: problem }));
          const operation = yield* Effect.serviceOption(Operation);
          if (Option.isNone(operation) || !operation.value)
            return yield* Effect.die(new Error("Docs needs a call context."));
          const result = delivered(tool.name, args, yield* tool.run(args, operation.value));
          if (!isRead) return result;
          const record = asRecord(result);
          return {
            ...asRecord(selectFields(record, fields)),
            ...(record["page"] ? { page: record["page"] } : {}),
            ...(record["truncated"] ? { truncated: record["truncated"] } : {}),
          };
        }).pipe(
          Effect.catchDefect((defect) =>
            defect instanceof ConnectorCallError ? Effect.fail(new Refusal({ error: defect })) : Effect.die(defect),
          ),
        ),
    };
    return isRead
      ? read(connection, spec)
      : write(connection, { ...spec, destructive: tool.annotations.destructiveHint !== false });
  });
}

interface DocsTool {
  name: string;
  description: string;
  input: Schema.Codec<JsonRecord>;
  output: Schema.Top;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  writeSteps?: Readonly<Record<string, "once">>;
  run: (args: JsonRecord, ctx: ConnectorContext) => Effect.Effect<any, HttpFailure, CallServices>;
}
function toolDefinitions(connection: Connection, client: GoogleClient): DocsTool[] {
  const revision = (args: JsonRecord): string | undefined =>
    typeof args["requiredRevisionId"] === "string" ? args["requiredRevisionId"] : undefined;

  return [
    {
      name: "get_document",
      description:
        "Get one Google Doc as readable markdown-ish text per tab, with its title and revisionId; withIndexes adds the start/end indexes edits target. Cannot search or list documents.",
      annotations: { readOnlyHint: true },
      input: schemas.GET_DOCUMENT_INPUT,
      output: schemas.GET_DOCUMENT_OUTPUT,
      run: (args, ctx) =>
        Effect.gen(function* () {
          const documentId = String(args["documentId"]);

          if (args["cursor"] !== undefined && args["withIndexes"] !== true) {
            throw new ConnectorCallError("invalid_args", "cursor pages index rows; send it with withIndexes: true.");
          }
          const binding = { ...args, fields: undefined };
          let from = 0;
          let expectedSnapshot: string | undefined;
          if (typeof args["cursor"] === "string") {
            const payload = yield* boundCursor.decode("get_document", binding, args["cursor"]);
            let parsed: unknown;
            try {
              parsed = JSON.parse(payload);
            } catch {
              throw new ConnectorCallError("invalid_args", "Invalid document cursor; start a fresh indexed read.");
            }
            const claim = asRecord(parsed);
            if (typeof claim["snapshot"] !== "string" || !Number.isSafeInteger(claim["from"]) || claim["from"] <= 0)
              throw new ConnectorCallError("invalid_args", "Invalid document cursor position.");
            from = claim["from"];
            expectedSnapshot = claim["snapshot"];
          }
          const suggestions =
            typeof args["suggestions"] === "string" ? SUGGESTION_MODES[args["suggestions"]] : undefined;
          const document = asRecord(
            yield* client.json({
              method: "GET",
              path: `/documents/${encodeURIComponent(documentId)}`,
              template: "/documents/{documentId}",
              query: { includeTabsContent: true, suggestionsViewMode: suggestions },
            }),
          );
          let tabs = flattenTabs(document);
          const wanted = typeof args["tabId"] === "string" ? args["tabId"] : undefined;
          if (wanted !== undefined) {
            tabs = tabs.filter((tab) => tab.tabId === wanted);
            if (tabs.length === 0) {
              const known = flattenTabs(document)
                .map((tab) => keptId(tab.tabId, "tabId", "tabId", []))
                .filter((id) => id !== undefined);
              throw new ConnectorCallError(
                "not_found",
                `This document has no tab ${wanted}. Its tabs are: ${known.slice(0, 20).join(", ") || "none listed"}${known.length > 20 ? ", …" : ""}.`,
              );
            }
          }

          const withIndexes = args["withIndexes"] === true;
          let budget = typeof args["maxChars"] === "number" ? args["maxChars"] : DEFAULT_MAX_CHARS;
          // Index rows form one sequence across tabs; a page is the rows from
          // the cursor's ordinal until the byte budget is spent.
          const snapshot = withIndexes
            ? yield* Effect.promise(async () => {
                const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(document)));
                return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
              })
            : undefined;
          if (expectedSnapshot !== undefined && expectedSnapshot !== snapshot)
            throw new ConnectorCallError(
              "conflict",
              "This document changed since the indexed read. Start again without a cursor and plan edits at the new revision.",
            );
          let ordinal = 0;
          let pageBytes = 0;
          let next: number | undefined;
          const dropped: string[] = [];
          const truncated: string[] = [];
          const title = boundedTitle(ctx, document["title"]);
          if (title !== undefined && title !== document["title"]) truncated.push("title");
          const rendered = tabs.map((tab, index) => {
            const rows: IndexRow[] | undefined = withIndexes ? [] : undefined;
            const sources: TabSources = {
              lists: asRecord(tab.documentTab["lists"]),
              footnotes: asRecord(tab.documentTab["footnotes"]),
              inlineObjects: asRecord(tab.documentTab["inlineObjects"]),
            };
            const { text: full, notRendered } = renderTab(ctx, tab.documentTab, sources, rows);
            const cut = capped(ctx, full, budget);
            const tabTitle = boundedTitle(ctx, tab.title);
            if (tabTitle !== undefined && tabTitle !== tab.title) truncated.push(`tabs[${index}].title`);
            budget = Math.max(0, budget - full.length);
            if (cut.textTruncated) truncated.push(`tabs[${index}].text`);
            let elements: IndexRow[] | undefined;
            if (rows) {
              elements = [];
              for (const row of rows) {
                const at = ordinal;
                ordinal += 1;
                if (at < from || next !== undefined) continue;
                const size = jsonBytes(row) + 1;
                if (pageBytes + size > ELEMENT_PAGE_BYTES) {
                  next = at;
                  continue;
                }
                pageBytes += size;
                const { previewCut, ...kept } = row;
                if (previewCut) truncated.push(`tabs[${index}].elements[].text`);
                elements.push(kept);
              }
            }
            return compact({
              tabId: keptId(tab.tabId, "tabId", `tabs[${index}].tabId`, dropped),
              title: tabTitle,
              parentTabId: keptId(tab.parentTabId, "tabId", `tabs[${index}].parentTabId`, dropped),
              nestingLevel: tab.nestingLevel,
              endIndex: endIndexOf(tab.documentTab["body"]),
              text: cut.text,
              notRendered: notRendered.length > 0 ? notRendered : undefined,
              elements,
            });
          });
          if (from > ordinal) throw new ConnectorCallError("invalid_args", "Invalid document cursor position.");
          const nextCursor =
            next === undefined
              ? undefined
              : yield* boundCursor.encode("get_document", binding, JSON.stringify({ snapshot, from: next }));
          return compact({
            documentId,
            title,
            revisionId: keptId(document["revisionId"], "revisionId", "revisionId", dropped),
            url: documentUrl(documentId),
            dropped: droppedField(dropped),
            tabs: rendered,
            truncated: truncated.length ? [...new Set(truncated)] : undefined,
            page: withIndexes ? compact({ hasMore: next !== undefined, nextCursor }) : undefined,
          });
        }),
    },
    {
      name: "create_document",
      writeSteps: { create: "once", initialText: "once" },
      description:
        "Create a new Google Doc in the user's My Drive root with a title and optional plain-text body. Cannot choose a folder, apply a template, or copy a document.",
      // Additive: a new document changes nothing that existed. Not read-only,
      // so program calls require a writable endpoint; other writes use
      // call_destructive_tool. The host controls approval.
      annotations: { readOnlyHint: false, destructiveHint: false },
      input: schemas.CREATE_DOCUMENT_INPUT,
      output: schemas.CREATE_DOCUMENT_OUTPUT,
      run: (args, ctx) =>
        Effect.gen(function* () {
          // Google's create takes a title and ignores any content, so a body is
          // a second, separate edit. Creating is not idempotent: every failure
          // that may have left a document behind says so and is not retryable.
          const title = String(args["title"]);
          const createdButUnknown = `Google Docs created the document (HTTP 2xx), but its reply could not be read, so its id is unknown. Do not create it again; find "${title}" in Drive (a Google Drive connection's search) and use that id.`;
          const created = yield* client
            .json({ method: "POST", path: "/documents", template: "/documents", body: { title } }, { step: "create" })
            .pipe(
              Effect.map(asRecord),
              Effect.catch((failure) =>
                !ctx.signal?.aborted && writeOutcome(failure) === "probably-applied"
                  ? googleFailureMessage(connection, failure, () => createdButUnknown)
                  : Effect.fail(failure),
              ),
            );
          const dropped: string[] = [];
          // An id that could not be passed back is no id at all.
          const documentId = keptId(created["documentId"], "documentId", "documentId", dropped);
          if (!documentId) throw uncertain(createdButUnknown, ctx);
          yield* (yield* Recovery).record({ documentId });
          let revisionId = keptId(created["revisionId"], "revisionId", "revisionId", dropped);
          if (typeof args["text"] === "string") {
            const reply = yield* batchUpdate(
              client,
              documentId,
              [{ insertText: { text: args["text"], endOfSegmentLocation: {} } }],
              undefined,
              "initialText",
            ).pipe(
              Effect.catch((cause) => {
                // The document exists now. A retry of this call would make a
                // second one, so the failure names it and is not retryable. Only
                // an explicit refusal proves the text is absent; anything else
                // sends the caller to look before appending.
                return googleFailureMessage(connection, cause, (detail) => {
                  const sentence = /[.!?]$/.test(detail.trim()) ? detail.trim() : `${detail.trim()}.`;
                  return ["refused", "not-sent"].includes(writeOutcome(cause))
                    ? `Created document ${documentId}, but Google refused its initial text: ${sentence} Do not create it again; add the text with append_text on ${documentId}.`
                    : `Created document ${documentId}, but its initial text was not confirmed: ${sentence} Do not create it again; read ${documentId} with get_document, and append the text with append_text only if it is missing.`;
                });
              }),
            );
            revisionId = revisionAfter(reply, dropped) ?? revisionId;
          }
          return compact({
            documentId,
            // The title this call sent, not Google's echo of it.
            title,
            revisionId,
            url: documentUrl(documentId),
            dropped: droppedField(dropped),
          });
        }),
    },
    {
      name: "append_text",
      description:
        "Append plain text to the end of a Google Doc's body, or of one tab. It joins the last paragraph; start with \\n for a new one. Never removes or restyles text.",
      // Additive: the text lands after everything that was there.
      annotations: { readOnlyHint: false, destructiveHint: false },
      input: schemas.APPEND_TEXT_INPUT,
      output: schemas.APPEND_TEXT_OUTPUT,
      run: (args) =>
        Effect.gen(function* () {
          const reply = yield* batchUpdate(
            client,
            args["documentId"],
            [{ insertText: { text: args["text"], endOfSegmentLocation: compact({ tabId: args["tabId"] }) } }],
            revision(args),
          );
          return savedEdit(args["documentId"], reply);
        }),
    },
    {
      name: "insert_text",
      description:
        "Insert plain text at one UTF-16 index of a Google Doc's body, from get_document withIndexes. Inserts only; nothing existing is removed or restyled.",
      // Additive: text goes in at a point; nothing that was there is lost.
      annotations: { readOnlyHint: false, destructiveHint: false },
      input: schemas.INSERT_TEXT_INPUT,
      output: schemas.INSERT_TEXT_OUTPUT,
      run: (args) =>
        Effect.gen(function* () {
          const reply = yield* batchUpdate(
            client,
            args["documentId"],
            [{ insertText: { text: args["text"], location: compact({ index: args["index"], tabId: args["tabId"] }) } }],
            revision(args),
          );
          return savedEdit(args["documentId"], reply);
        }),
    },
    {
      name: "replace_all_text",
      description:
        "Replace every occurrence of a string (or regex) in a Google Doc, in all tabs or the listed ones, and report how many changed. Overwrites text; no preview.",
      // Destructive: the matched text is gone, and a broad match can rewrite
      // far more of the document than was meant.
      annotations: { readOnlyHint: false, destructiveHint: true },
      input: schemas.REPLACE_ALL_TEXT_INPUT,
      output: schemas.REPLACE_ALL_TEXT_OUTPUT,
      run: (args) =>
        Effect.gen(function* () {
          const reply = yield* batchUpdate(
            client,
            args["documentId"],
            [
              {
                replaceAllText: compact({
                  containsText: compact({
                    text: args["find"],
                    matchCase: args["matchCase"] === true,
                    searchByRegex: args["regex"] === true ? true : undefined,
                  }),
                  replaceText: args["replaceWith"],
                  tabsCriteria: Array.isArray(args["tabIds"]) ? { tabIds: args["tabIds"] } : undefined,
                }),
              },
            ],
            revision(args),
          );
          const changed = integer(
            asRecord(asRecord(asArray(reply["replies"])[0])["replaceAllText"])["occurrencesChanged"],
          );
          // Google omits a zero count from the reply.
          return { ...savedEdit(args["documentId"], reply), occurrencesChanged: changed ?? 0 };
        }),
    },
    {
      name: "batch_update_document",
      description:
        "Apply raw Docs API documents.batchUpdate requests to one Google Doc at a required revision, atomically: all apply or none. Always destructive; prefer named edits.",
      // Destructive by construction: a raw request can delete ranges, restyle
      // the whole document, or drop tables, and no schema here can tell which.
      annotations: { readOnlyHint: false, destructiveHint: true },
      input: schemas.BATCH_UPDATE_DOCUMENT_INPUT,
      output: schemas.BATCH_UPDATE_DOCUMENT_OUTPUT,
      run: (args) =>
        Effect.gen(function* () {
          const reply = yield* batchUpdate(client, args["documentId"], args["requests"], revision(args));
          return boundedReplies(savedEdit(args["documentId"], reply), asArray(reply["replies"]).map(asRecord));
        }),
    },
  ];
}
