/**
 * Google Docs as the signed-in Workspace user: read a document as readable
 * text with the indexes an edit needs, create one, append, insert, or replace
 * text, and send raw `documents.batchUpdate` requests behind approval.
 * Hand-written against the Docs API v1 reference
 * (https://developers.google.com/workspace/docs/api/reference/rest).
 *
 * Whose documents. Access is a service account with domain-wide delegation
 * (`src/providers/google/workspace.ts`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. Docs has no `users/me` path to confine beneath — a document id
 * addresses a Drive file — so the token's subject is the confinement: a
 * request reaches exactly the documents Drive shares with that person, and no
 * argument names anyone else.
 *
 * Why no search. Finding a document is Drive's job (`files.list` with a Docs
 * MIME type), and this connection requests only `documents`, which cannot
 * list anything. Duplicating a listing here would need a Drive scope this
 * connector deliberately does not ask for.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `scripts/drift/docs-endpoints.json` records the three methods the tools
 * call, and `npm run providers:check -- --provider docs` reports a touched
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

/**
 * The Docs API root. Unlike Gmail there is no per-user path segment: the
 * delegated token's subject decides which documents a request can reach.
 */
export const DOCS_API_BASE_URL = "https://docs.googleapis.com/v1";

/**
 * Exactly the scope this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list for it. `documents` reads
 * and edits Docs the user can reach; it lists nothing and touches no other
 * Drive file type.
 */
export const DOCS_SCOPES = ["https://www.googleapis.com/auth/documents"] as const;

/** Options for {@link docs}: the shared Workspace delegation options. */
export type DocsOptions = GoogleWorkspaceOptions;

/** Rendered characters kept across a document's tabs by default. */
const DEFAULT_MAX_CHARS = 20_000;
/** Connecta's ceiling on one rendering; Google caps a document near 1.02M characters. */
const MAX_CHARS = 1_000_000;
/** Index rows returned at most, across tabs, when indexes are asked for. */
const MAX_ELEMENTS = 2_000;
/** Characters of each index row's text preview. */
const PREVIEW_CHARS = 80;
/** One text argument; Google caps a whole document near 1.02M characters. */
const MAX_TEXT_CHARS = 1_000_000;
/** Raw requests in one batch_update_document call; connecta's cap. */
const MAX_REQUESTS = 100;

/**
 * The Request kinds batch_update_document forwards: every generally available
 * member of the Docs API's `Request` union. The Developer Preview comment and
 * suggestion kinds are left out — they answer only for enrolled projects, and
 * comments are Drive's surface. A kind is checked, its contents are not:
 * Google owns their shape, and a drift check reports a new or retired kind.
 */
const REQUEST_KINDS = [
  "addDocumentTab",
  "createDropdownDefinition",
  "createFooter",
  "createFootnote",
  "createHeader",
  "createNamedRange",
  "createParagraphBullets",
  "deleteContentRange",
  "deleteDropdownDefinition",
  "deleteFooter",
  "deleteHeader",
  "deleteNamedRange",
  "deleteParagraphBullets",
  "deletePositionedObject",
  "deleteTab",
  "deleteTableColumn",
  "deleteTableRow",
  "insertDate",
  "insertDropdown",
  "insertInlineImage",
  "insertPageBreak",
  "insertPerson",
  "insertRichLink",
  "insertSectionBreak",
  "insertTable",
  "insertTableColumn",
  "insertTableRow",
  "insertText",
  "mergeTableCells",
  "pinTableHeaderRows",
  "replaceAllText",
  "replaceImage",
  "replaceNamedRangeContent",
  "unmergeTableCells",
  "updateDocumentStyle",
  "updateDocumentTabProperties",
  "updateDropdownDefinitionProperties",
  "updateDropdownProperties",
  "updateNamedStyle",
  "updateParagraphStyle",
  "updateSectionStyle",
  "updateTableCellStyle",
  "updateTableColumnProperties",
  "updateTableRowStyle",
  "updateTextStyle",
] as const;
/**
 * A document with every tab, as JSON. Styles ride on every text run, so the
 * JSON is many times the text; this admits documents near Google's own size
 * limit without letting one exhaust a Worker.
 */
const DOCS_MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

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

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
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
}

interface RenderState {
  sources: TabSources;
  /** Footnotes in the order the body first references them. */
  footnotes: { id: string; number: string }[];
  /** Index rows, collected only when asked for. */
  rows: IndexRow[] | undefined;
  /** Set when rendered text includes a suggested insertion or deletion. */
  marks: { suggested: boolean };
}

/**
 * What a tab holds that its text does not show, named so a reader never
 * mistakes the rendering for the whole document: headers, footers, floating
 * (positioned) images, and — in the inline view — which text is a suggestion.
 */
const NOT_RENDERED = ["headers", "footers", "positioned_objects", "suggestion_marks"] as const;

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
  if (element["horizontalRule"]) return { text: "---" };
  if (element["equation"]) return { text: "[equation]" };
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
  const lastPiece = pieces[pieces.length - 1];
  if (lastPiece) lastPiece.text = lastPiece.text.replace(/\n$/, "");
  return pieces
    .map((piece) => (piece.url && piece.text.trim() ? `[${piece.text}](${piece.url})` : piece.text))
    .join("")
    .replaceAll(VERTICAL_TAB, "\n");
}

function preview(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

/** Render structural elements as markdown-ish lines, collecting index rows. */
function renderContent(
  content: unknown,
  state: RenderState,
  cell?: { row: number; column: number },
): string[] {
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
      state.rows?.push(
        compact({
          type: "paragraph" as const,
          startIndex: start,
          endIndex: end,
          style: style && style !== "NORMAL_TEXT" ? style : undefined,
          row: cell?.row,
          column: cell?.column,
          text: preview(body),
        }),
      );
    } else if (element["table"]) {
      state.rows?.push(compact({ type: "table" as const, startIndex: start, endIndex: end, row: cell?.row, column: cell?.column }));
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
    }
    // A section break has no text and is not an edit target.
  }
  return lines;
}

/** One tab's body as text, with its footnotes after it. */
function renderTab(
  tab: JsonRecord,
  sources: TabSources,
  rows: IndexRow[] | undefined,
): { text: string; notRendered: (typeof NOT_RENDERED)[number][] } {
  const marks = { suggested: false };
  const state: RenderState = { sources, footnotes: [], rows, marks };
  const lines = renderContent(asRecord(tab["body"])["content"], state);
  const notes = state.footnotes.map(({ id, number }) => {
    const footnote = asRecord(sources.footnotes[id]);
    // Footnote content is its own segment: rendered, never indexed.
    const inner: RenderState = { sources, footnotes: [], rows: undefined, marks };
    return `[^${number}]: ${renderContent(footnote["content"], inner).join(" ").trim()}`;
  });
  const present = (key: string) => Object.keys(asRecord(tab[key])).length > 0;
  const notRendered = NOT_RENDERED.filter((part) =>
    part === "suggestion_marks"
      ? marks.suggested
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

/** Cut text at `max` characters, never inside a surrogate pair, and say so. */
function capped(value: string, max: number): { text: string; textTruncated: boolean } {
  if (value.length <= max) return { text: value, textTruncated: false };
  let cut = max;
  const code = value.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
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

/** The revision a batchUpdate left the document at, when Google reports it. */
function revisionAfter(reply: JsonRecord): string | undefined {
  return text(asRecord(reply["writeControl"])["requiredRevisionId"]);
}

/**
 * One `documents.batchUpdate`, atomic on Google's side: every request applies
 * or none does. With `requiredRevisionId`, Google refuses the batch if the
 * document has moved on. Its refusal is a 400 that does not say which
 * precondition failed, so a refused edit that named a revision is followed by
 * one cheap read of the current revision: if it differs, the honest answer is
 * `conflict`, never a guess from Google's prose.
 */
async function batchUpdate(
  client: GoogleWorkspaceClient,
  ctx: ConnectorContext,
  documentId: string,
  requests: unknown[],
  requiredRevisionId: string | undefined,
): Promise<JsonRecord> {
  try {
    return asRecord(
      await client.json(
        {
          method: "POST",
          path: batchPath(documentId),
          body: compact({
            requests,
            writeControl: requiredRevisionId ? { requiredRevisionId } : undefined,
          }),
        },
        ctx,
      ),
    );
  } catch (error) {
    if (
      !requiredRevisionId ||
      !(error instanceof ConnectorCallError) ||
      (error.code !== "invalid_args" && error.code !== "connector_call_failed")
    ) {
      throw error;
    }
    let current: string | undefined;
    try {
      current = text(
        asRecord(
          await client.json(
            {
              method: "GET",
              path: `/documents/${encodeURIComponent(documentId)}`,
              query: { fields: "revisionId" },
            },
            ctx,
          ),
        )["revisionId"],
      );
    } catch {
      throw error;
    }
    if (current === undefined || current === requiredRevisionId) throw error;
    throw new ConnectorCallError(
      "conflict",
      `Google Docs refused the edit: the document is now at revision ${current}, not the requiredRevisionId it named, so someone changed it first. Nothing was applied. Re-read it with get_document, recompute any indexes, and retry against the new revisionId.`,
      { cause: error },
    );
  }
}

function savedEdit(documentId: string, reply: JsonRecord): JsonRecord {
  return compact({ documentId, revisionId: revisionAfter(reply) });
}

// --- Schemas -----------------------------------------------------------------------

function input(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const DOCUMENT_ID: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9_-]+$",
  description: "Document id: the part after /d/ in its URL, or a Drive file id for a Google Doc.",
};

const TAB_ID_PATTERN = "^[A-Za-z0-9._-]+$";

function tabIdProperty(description: string): JsonSchema {
  return { type: "string", minLength: 1, maxLength: 128, pattern: TAB_ID_PATTERN, description };
}

const REVISION_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: "^\\S+$",
  description: "revisionId from get_document or a previous edit. If the document has changed since, the edit fails with conflict and nothing is applied.",
};

const TEXT_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_TEXT_CHARS,
  description: "Plain text; \\n starts a new paragraph. Google caps a document near 1.02 million characters.",
};

const EDIT_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    documentId: { type: "string" },
    revisionId: { type: "string" },
  },
  required: ["documentId"],
};

const TAB_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    tabId: { type: "string" },
    title: { type: "string" },
    parentTabId: { type: "string" },
    nestingLevel: { type: "integer" },
    endIndex: { type: "integer" },
    text: { type: "string" },
    textTruncated: { type: "boolean" },
    notRendered: { type: "array", items: { type: "string", enum: [...NOT_RENDERED] } },
    elements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["paragraph", "table", "table_of_contents"] },
          startIndex: { type: "integer" },
          endIndex: { type: "integer" },
          style: { type: "string" },
          row: { type: "integer" },
          column: { type: "integer" },
          text: { type: "string" },
        },
      },
    },
  },
  required: ["text", "textTruncated"],
};

// --- Tools -------------------------------------------------------------------------

function tools(client: GoogleWorkspaceClient): ApiTool[] {
  const revision = (args: JsonRecord): string | undefined =>
    typeof args["requiredRevisionId"] === "string" ? args["requiredRevisionId"] : undefined;

  return [
    {
      name: "get_document",
      description:
        "Get one Google Doc as readable markdown-ish text per tab, with its title and revisionId; withIndexes adds the start/end indexes edits target. Cannot search or list documents.",
      annotations: { readOnlyHint: true },
      inputSchema: input(
        {
          documentId: DOCUMENT_ID,
          tabId: tabIdProperty("Render only this tab (from a previous get_document); omit for every tab."),
          maxChars: {
            type: "integer",
            minimum: 0,
            maximum: MAX_CHARS,
            description: `Characters of text kept across all rendered tabs, 0 to ${MAX_CHARS}; defaults to ${DEFAULT_MAX_CHARS}. Connecta's cap. Longer text ends with a truncation marker.`,
          },
          withIndexes: {
            type: "boolean",
            description: `Add each tab's elements: every paragraph, table, and table of contents with UTF-16 startIndex and endIndex, at most ${MAX_ELEMENTS} in all.`,
          },
          suggestions: {
            type: "string",
            enum: ["inline", "accepted", "rejected"],
            description: "How suggested edits read: inline (editors' default; the indexes edits use), or a preview with all accepted or all rejected (indexes not valid for edits).",
          },
        },
        ["documentId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          title: { type: "string" },
          revisionId: { type: "string" },
          url: { type: "string" },
          tabs: { type: "array", items: TAB_OUTPUT },
          elementsTruncated: { type: "boolean" },
        },
        required: ["documentId", "tabs"],
      },
      handler: async (args, ctx) => {
        const documentId = String(args["documentId"]);
        const suggestions = typeof args["suggestions"] === "string" ? SUGGESTION_MODES[args["suggestions"]] : undefined;
        const document = asRecord(
          await client.json(
            {
              method: "GET",
              path: `/documents/${encodeURIComponent(documentId)}`,
              query: { includeTabsContent: true, suggestionsViewMode: suggestions },
            },
            ctx,
          ),
        );
        let tabs = flattenTabs(document);
        const wanted = typeof args["tabId"] === "string" ? args["tabId"] : undefined;
        if (wanted !== undefined) {
          tabs = tabs.filter((tab) => tab.tabId === wanted);
          if (tabs.length === 0) {
            const known = flattenTabs(document)
              .map((tab) => tab.tabId)
              .filter((id) => id !== undefined);
            throw new ConnectorCallError(
              "not_found",
              `This document has no tab ${wanted}. Its tabs are: ${known.slice(0, 20).join(", ") || "none listed"}${known.length > 20 ? ", …" : ""}.`,
            );
          }
        }
        const withIndexes = args["withIndexes"] === true;
        let budget = typeof args["maxChars"] === "number" ? args["maxChars"] : DEFAULT_MAX_CHARS;
        let elementBudget = MAX_ELEMENTS;
        let elementsTruncated = false;
        const rendered = tabs.map((tab) => {
          const rows: IndexRow[] | undefined = withIndexes ? [] : undefined;
          const sources: TabSources = {
            lists: asRecord(tab.documentTab["lists"]),
            footnotes: asRecord(tab.documentTab["footnotes"]),
            inlineObjects: asRecord(tab.documentTab["inlineObjects"]),
          };
          const { text: full, notRendered } = renderTab(tab.documentTab, sources, rows);
          const cut = capped(full, budget);
          budget = Math.max(0, budget - full.length);
          let elements: IndexRow[] | undefined;
          if (rows) {
            elements = rows.slice(0, elementBudget);
            if (rows.length > elementBudget) elementsTruncated = true;
            elementBudget -= elements.length;
          }
          return compact({
            tabId: tab.tabId,
            title: tab.title,
            parentTabId: tab.parentTabId,
            nestingLevel: tab.nestingLevel,
            endIndex: endIndexOf(tab.documentTab["body"]),
            ...cut,
            notRendered: notRendered.length > 0 ? notRendered : undefined,
            elements,
          });
        });
        return compact({
          documentId: text(document["documentId"]) ?? documentId,
          title: text(document["title"]),
          revisionId: text(document["revisionId"]),
          url: documentUrl(text(document["documentId"]) ?? documentId),
          tabs: rendered,
          elementsTruncated: withIndexes ? elementsTruncated : undefined,
        });
      },
    },
    {
      name: "create_document",
      description:
        "Create a new Google Doc in the user's My Drive root with a title and optional plain-text body. Cannot choose a folder, apply a template, or copy a document.",
      // Additive: a new document changes nothing that existed. Not read-only,
      // so it crosses call_destructive_tool unless the deployment exempts it
      // in `execute.approval`; the provider never exempts itself.
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: input(
        {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 1000,
            pattern: "^[^\\r\\n]*$",
            description: "Document title, one line. Connecta's 1,000-character cap.",
          },
          text: { ...TEXT_PROPERTY, description: "Optional plain-text body; \\n starts a new paragraph." },
        },
        ["title"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          title: { type: "string" },
          revisionId: { type: "string" },
          url: { type: "string" },
        },
        required: ["documentId", "url"],
      },
      handler: async (args, ctx) => {
        // Google's create takes a title and ignores any content, so a body is
        // a second, separate edit.
        const created = asRecord(
          await client.json({ method: "POST", path: "/documents", body: { title: args["title"] } }, ctx),
        );
        const documentId = text(created["documentId"]);
        if (!documentId) {
          throw new ConnectorCallError(
            "connector_call_failed",
            "Google Docs answered the create without a document id.",
            { retryable: false },
          );
        }
        let revisionId = text(created["revisionId"]);
        if (typeof args["text"] === "string") {
          try {
            const reply = await batchUpdate(
              client,
              ctx,
              documentId,
              [{ insertText: { text: args["text"], endOfSegmentLocation: {} } }],
              undefined,
            );
            revisionId = revisionAfter(reply) ?? revisionId;
          } catch (cause) {
            // The document exists now. A retry of this call would make a
            // second one, so the failure names it and is not retryable.
            throw new ConnectorCallError(
              "connector_call_failed",
              `Created document ${documentId}, but writing its initial text failed: ${cause instanceof Error ? cause.message : String(cause)} Do not create it again; add the text with append_text on ${documentId}.`,
              { retryable: false, cause },
            );
          }
        }
        return compact({
          documentId,
          title: text(created["title"]) ?? args["title"],
          revisionId,
          url: documentUrl(documentId),
        });
      },
    },
    {
      name: "append_text",
      description:
        "Append plain text to the end of a Google Doc's body, or of one tab. It joins the last paragraph; start with \\n for a new one. Never removes or restyles text.",
      // Additive: the text lands after everything that was there.
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: input(
        {
          documentId: DOCUMENT_ID,
          text: TEXT_PROPERTY,
          tabId: tabIdProperty("Tab to append to; omit for the first tab."),
          requiredRevisionId: REVISION_PROPERTY,
        },
        ["documentId", "text"],
      ),
      outputSchema: EDIT_OUTPUT,
      handler: async (args, ctx) => {
        const reply = await batchUpdate(
          client,
          ctx,
          args["documentId"],
          [{ insertText: { text: args["text"], endOfSegmentLocation: compact({ tabId: args["tabId"] }) } }],
          revision(args),
        );
        return savedEdit(args["documentId"], reply);
      },
    },
    {
      name: "insert_text",
      description:
        "Insert plain text at one UTF-16 index of a Google Doc's body, from get_document withIndexes. Inserts only; nothing existing is removed or restyled.",
      // Additive: text goes in at a point; nothing that was there is lost.
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: input(
        {
          documentId: DOCUMENT_ID,
          index: {
            type: "integer",
            minimum: 1,
            maximum: 10_000_000,
            description: "UTF-16 index inside an existing paragraph, from get_document withIndexes; 1 is the body's start. Not a table's start index.",
          },
          text: TEXT_PROPERTY,
          tabId: tabIdProperty("Tab the index belongs to; omit for the first tab."),
          requiredRevisionId: REVISION_PROPERTY,
        },
        ["documentId", "index", "text"],
      ),
      outputSchema: EDIT_OUTPUT,
      handler: async (args, ctx) => {
        const reply = await batchUpdate(
          client,
          ctx,
          args["documentId"],
          [{ insertText: { text: args["text"], location: compact({ index: args["index"], tabId: args["tabId"] }) } }],
          revision(args),
        );
        return savedEdit(args["documentId"], reply);
      },
    },
    {
      name: "replace_all_text",
      description:
        "Replace every occurrence of a string (or regex) in a Google Doc, in all tabs or the listed ones, and report how many changed. Overwrites text; no preview.",
      // Destructive: the matched text is gone, and a broad match can rewrite
      // far more of the document than was meant.
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: input(
        {
          documentId: DOCUMENT_ID,
          find: {
            type: "string",
            minLength: 1,
            maxLength: 10_000,
            description: "Text to find. With regex: true, a regular expression in Google's RE2 syntax.",
          },
          replaceWith: {
            type: "string",
            maxLength: MAX_TEXT_CHARS,
            description: "Replacement text; an empty string deletes every match.",
          },
          matchCase: { type: "boolean", description: "Match case exactly. Defaults to false." },
          regex: { type: "boolean", description: "Treat find as an RE2 regular expression. Defaults to false." },
          tabIds: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: tabIdProperty("Tab id from get_document."),
            description: "Only these tabs; omit for every tab.",
          },
          requiredRevisionId: REVISION_PROPERTY,
        },
        ["documentId", "find", "replaceWith"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          occurrencesChanged: { type: "integer" },
          revisionId: { type: "string" },
        },
        required: ["documentId", "occurrencesChanged"],
      },
      handler: async (args, ctx) => {
        const reply = await batchUpdate(
          client,
          ctx,
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
        const changed = integer(asRecord(asRecord(asArray(reply["replies"])[0])["replaceAllText"])["occurrencesChanged"]);
        // Google omits a zero count from the reply.
        return { ...savedEdit(args["documentId"], reply), occurrencesChanged: changed ?? 0 };
      },
    },
    {
      name: "batch_update_document",
      description:
        "Apply raw Docs API documents.batchUpdate requests to one Google Doc at a required revision, atomically: all apply or none. Always destructive; prefer named edits.",
      // Destructive by construction: a raw request can delete ranges, restyle
      // the whole document, or drop tables, and no schema here can tell which.
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: input(
        {
          documentId: DOCUMENT_ID,
          requests: {
            type: "array",
            minItems: 1,
            maxItems: MAX_REQUESTS,
            items: {
              type: "object",
              minProperties: 1,
              maxProperties: 1,
              propertyNames: { enum: [...REQUEST_KINDS] },
              description: "One Docs API Request, exactly one kind (insertText, deleteContentRange, updateTextStyle, …), e.g. {\"deleteContentRange\":{\"range\":{\"startIndex\":5,\"endIndex\":9}}}. Indexes are UTF-16, from get_document withIndexes.",
            },
            description: `Requests in order, 1 to ${MAX_REQUESTS} (connecta's cap). Later requests see earlier ones' index shifts.`,
          },
          requiredRevisionId: {
            ...REVISION_PROPERTY,
            description: "revisionId from get_document or a previous edit; required, so raw edits are planned against what was read. A changed document fails conflict and nothing is applied.",
          },
        },
        ["documentId", "requests", "requiredRevisionId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          revisionId: { type: "string" },
          replies: { type: "array", items: { type: "object" } },
        },
        required: ["documentId", "replies"],
      },
      handler: async (args, ctx) => {
        const reply = await batchUpdate(client, ctx, args["documentId"], args["requests"], revision(args));
        // Replies are one small object per request (a created id, a count),
        // empty for most; they are what a later request needs, so kept whole.
        return { ...savedEdit(args["documentId"], reply), replies: asArray(reply["replies"]).map(asRecord) };
      },
    },
  ];
}

// --- Guide -------------------------------------------------------------------------

function usageGuide(purpose: string, instructions: string | undefined): string {
  const extra = instructions?.trim();
  return `# Google Docs usage

Reads and edits Google Docs as the signed-in person through Workspace delegation; it cannot search or list documents.

Connection purpose: ${purpose}

## Whose documents

Every call acts as the Workspace account deployment config maps the caller
to, and reaches exactly the documents Drive shares with that person. No
argument names an account. A call with none mapped fails \`auth_required\`;
only an operator can change the mapping.

## Finding a document

There is no search or list tool, and no pagination. Take the id from a
docs.google.com URL (the part after \`/d/\`), from the person, or from a
Google Drive connection's file search. A failure on an id may mean it does
not exist or is not shared with this person; Google does not say which.

## Reading

- \`get_document\` renders every tab as markdown-ish text: headings, lists,
  links, tables as pipe rows, footnotes after the body, images and other
  embeds as bracketed markers. Headers, footers, floating images, and
  comments are not rendered; a tab's \`notRendered\` names any it holds, and
  \`suggestion_marks\` there means the text mixes unmarked suggested
  insertions and deletions in (read with \`suggestions\` to preview). Text past \`maxChars\` (shared across tabs) ends with a marker;
  pass \`tabId\` to read one tab.
- Before an index-based edit, read with \`withIndexes: true\` and target an
  element's \`startIndex\`/\`endIndex\`. Indexes are UTF-16 code units and
  shift after every edit. Keep \`revisionId\` and pass it as
  \`requiredRevisionId\`, so an edit against a document someone else has
  changed fails \`conflict\` with nothing applied. Indexes from a suggestions
  preview (\`accepted\`/\`rejected\`) are not valid for edits.

## Editing

- \`create_document\` makes a new document in My Drive's root. A failure
  after the document exists names its id; append the text there rather than
  creating another.
- \`append_text\` joins the last paragraph; begin with \`\\n\` for a new one.
- \`replace_all_text\` changes every match at once; read first and make
  \`find\` specific.
- \`batch_update_document\` takes raw Docs API requests (\`deleteContentRange\`,
  \`updateTextStyle\`, \`insertTable\`, \`createParagraphBullets\`, …) for what
  the named tools cannot do. It is always destructive, and requires the
  \`requiredRevisionId\` from the read it was planned against: up to 100
  requests, each exactly one generally available kind (the Developer Preview
  comment and suggestion kinds are refused). Several requests in one
  call apply atomically, and each sees the index shifts of those before it;
  order deletions from the end of the document backwards.
${extra ? `\n## Connection instructions\n\n${extra}\n` : ""}`;
}

// --- Construction ------------------------------------------------------------------

/**
 * A maintained Google Docs connection acting as each signed-in Workspace user
 * through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Docs API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches documents.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new (or edit
 *    the service account's existing entry). Paste the client ID and add
 *    exactly this scope ({@link DOCS_SCOPES}):
 *    `https://www.googleapis.com/auth/documents`. One entry lists every
 *    Workspace provider's scopes, comma-separated. A new grant can take up to
 *    24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * docs("docs", {
 *   purpose: "Staff meeting notes and sermon drafts",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * Reads run in programs. `create_document`, `append_text`, and `insert_text`
 * are additive writes the host approves unless the deployment exempts them in
 * `execute.approval`; `replace_all_text` and `batch_update_document` are
 * destructive.
 */
export function docs(id: string, options: DocsOptions): Connector {
  const connection = workspaceConnection("docs", options);
  const client = googleWorkspaceClient({
    provider: "Google Docs",
    api: "Google Docs API",
    baseUrl: options.baseUrl?.trim() || DOCS_API_BASE_URL,
    scopes: DOCS_SCOPES,
    maxResponseBytes: DOCS_MAX_RESPONSE_BYTES,
    // A document is a Drive file: Google answers 404 both for an id that does
    // not exist and for one this person cannot see (H11).
    notFound: "ambiguous",
    connection,
  });
  return api(id, {
    ...defined({
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
    title: options.title ?? "Google Docs",
    description: `Google Docs as the signed-in Workspace user: read, create, and edit documents by id — ${connection.purpose}`,
    usageGuide: {
      content: usageGuide(connection.purpose, options.instructions),
      summary: "Each caller's own Docs by id: readable text with edit indexes, append/insert/replace, raw batchUpdate.",
      // Required: whose documents they are, that ids come from elsewhere, and
      // that indexes shift and go stale are conventions no schema can carry.
      required: true,
    },
    tools: tools(client),
  });
}
