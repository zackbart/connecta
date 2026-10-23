// Google Docs' vendor on the provider kit (C.7 step 1).
import { Schema } from "effect";
import { get, post, vendor } from "../../http/vendor.js";
import { googleErrors, googleSafety, type GoogleProduct } from "../_shared/google/kit.js";
import { DOCS_SCOPES } from "./lib/constants.js";

export const DOCS: GoogleProduct = {
  provider: "Google Docs",
  api: "Google Docs API",
  scopes: DOCS_SCOPES,
  // A document is a Drive file: 404 means absent or not shared with this user.
  notFound: "ambiguous",
};

const DocumentId = { documentId: Schema.String };
export const getDocument = get("getDocument", "/documents/:documentId", {
  params: DocumentId,
  query: {
    includeTabsContent: Schema.optionalKey(Schema.String),
    suggestionsViewMode: Schema.optionalKey(Schema.String),
  },
  success: Schema.Unknown,
});

const OPERATIONS = [
  getDocument,
  post("createDocument", "/documents", { payload: Schema.Unknown, success: Schema.Unknown }),
  post("batchUpdate", "/documents/:documentId:batchUpdate", {
    params: DocumentId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
] as const;

/** The three methods declared by the Docs API v1 Discovery document. */
export const DocsApi = {
  ...vendor({ name: "Google Docs", manifestBase: "/v1" }, ...OPERATIONS),
  // Public Docs v1 schema names only. Dynamic ids and every value stay private.
  fixedKeys: {
    documentId: "Document.documentId identifies the document in read and create replies.",
    revisionId: "Document.revisionId supplies the revision used for edits.",
    body: "Document and DocumentTab body contain structural elements.",
    tabs: "Document.tabs contains the document's tabs.",
    childTabs: "Tab.childTabs contains nested tabs.",
    tabProperties: "Tab.tabProperties carries tab identity and nesting metadata.",
    documentTab: "Tab.documentTab contains the tab's document content.",
    tabId: "TabProperties.tabId identifies the tab.",
    parentTabId: "TabProperties.parentTabId identifies a parent tab.",
    nestingLevel: "TabProperties and Bullet nestingLevel specify hierarchy depth.",
    startIndex: "StructuralElement.startIndex locates an editable element.",
    endIndex: "StructuralElement.endIndex locates an element's end.",
    paragraph: "StructuralElement.paragraph contains a paragraph's text elements.",
    paragraphStyle: "Paragraph.paragraphStyle supplies the paragraph's named style.",
    namedStyleType: "ParagraphStyle.namedStyleType selects heading rendering.",
    elements: "Paragraph.elements contains its ordered inline elements.",
    textRun: "ParagraphElement.textRun contains original text before normalization.",
    textStyle: "TextRun.textStyle contains the text's link metadata.",
    link: "TextStyle.link contains the text's hyperlink target.",
    bullet: "Paragraph.bullet refers to a list and nesting level.",
    listId: "Bullet.listId refers to the document's list definition.",
    lists: "DocumentTab.lists maps dynamic list ids to definitions.",
    listProperties: "List.listProperties contains the list's nesting definitions.",
    nestingLevels: "ListProperties.nestingLevels specifies each list level.",
    glyphType: "NestingLevel.glyphType distinguishes ordered lists.",
    footnotes: "DocumentTab.footnotes maps dynamic footnote ids to content.",
    footnoteReference: "ParagraphElement.footnoteReference identifies an inline footnote.",
    footnoteId: "FootnoteReference.footnoteId refers to a footnote's content.",
    footnoteNumber: "FootnoteReference.footnoteNumber supplies the visible marker.",
    inlineObjects: "DocumentTab.inlineObjects maps dynamic image ids to metadata.",
    inlineObjectElement: "ParagraphElement.inlineObjectElement refers to inline image metadata.",
    inlineObjectId: "InlineObjectElement.inlineObjectId refers to an inline object.",
    inlineObjectProperties: "InlineObject.inlineObjectProperties contains embedded object metadata.",
    embeddedObject: "InlineObjectProperties.embeddedObject supplies image labels.",
    person: "ParagraphElement.person contains a person chip.",
    personProperties: "Person.personProperties supplies a person's displayed label.",
    email: "PersonProperties.email is the fallback displayed person label.",
    richLink: "ParagraphElement.richLink contains a rich-link chip.",
    richLinkProperties: "RichLink.richLinkProperties contains the chip's label and target.",
    dateElement: "ParagraphElement.dateElement contains a date chip.",
    dateElementProperties: "DateElement.dateElementProperties supplies the date's display text.",
    displayText: "DateElementProperties.displayText is the rendered date label.",
    dropdown: "ParagraphElement.dropdown contains a dropdown chip.",
    dropdownProperties: "Dropdown.dropdownProperties supplies the selected label.",
    displayValue: "DropdownProperties.displayValue is the selected dropdown label.",
    autoText: "ParagraphElement.autoText identifies generated page numbers or counts.",
    horizontalRule: "ParagraphElement.horizontalRule marks a horizontal rule.",
    equation: "ParagraphElement.equation marks an equation with no exposed text.",
    pageBreak: "ParagraphElement.pageBreak marks an explicit page break.",
    columnBreak: "ParagraphElement.columnBreak marks an explicit column break.",
    table: "StructuralElement.table contains table rows.",
    tableRows: "Table.tableRows contains ordered rows.",
    tableCells: "TableRow.tableCells contains ordered cell content.",
    tableOfContents: "StructuralElement.tableOfContents marks a table of contents.",
    sectionBreak: "StructuralElement.sectionBreak marks a non-text section boundary.",
    suggestedInsertionIds: "ParagraphElement suggestions identify text that includes suggested insertions.",
    suggestedDeletionIds: "ParagraphElement suggestions identify text that includes suggested deletions.",
    headers: "DocumentTab.headers records content omitted from the body rendering.",
    footers: "DocumentTab.footers records content omitted from the body rendering.",
    positionedObjects: "DocumentTab.positionedObjects records floating images omitted from rendering.",
    writeControl: "BatchUpdateDocumentResponse.writeControl carries the resulting revision guard.",
    requiredRevisionId: "WriteControl.requiredRevisionId identifies the revision after an edit.",
    replies: "BatchUpdateDocumentResponse.replies contains ordered per-request replies.",
    replaceAllText: "Response.replaceAllText contains a text replacement's result.",
    occurrencesChanged: "ReplaceAllTextResponse.occurrencesChanged counts replacements.",
  },
};
export const errors = googleErrors(DOCS);
export const safety = googleSafety(DOCS.provider, OPERATIONS);

/** Delegation has no operator credential to test; this probe is never run. */
export const probe = {
  operation: getDocument,
  request: { params: { documentId: "-" } },
  describe: () => "Google Docs delegation has no credential to test.",
};
