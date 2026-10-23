// Slides' five API methods; the shared Google layer owns delegation, errors
// and value safety. Step 1 preserves the tools' legacy schemas and wire bytes.
import { Schema } from "effect";
import { get, post, vendor } from "../../http/vendor.js";
import { googleErrors, googleSafety, type GoogleProduct } from "../_shared/google/kit.js";
import { SLIDES_SCOPES } from "./lib/constants.js";

export const SLIDES: GoogleProduct = {
  provider: "Google Slides",
  api: "Google Slides API",
  scopes: SLIDES_SCOPES,
  // A deck is a Drive file: 404 cannot distinguish absence from lack of access.
  notFound: "ambiguous",
};

const PresentationId = { presentationId: Schema.String };
const PageId = { ...PresentationId, pageObjectId: Schema.String };
const ReadQuery = {
  fields: Schema.optionalKey(Schema.String),
  commentsViewMode: Schema.optionalKey(Schema.String),
};

// Discovery calls this one parameter `presentationsId` (plural).
export const getPresentation = get("getPresentation", "/presentations/:presentationsId", {
  params: { presentationsId: Schema.String },
  query: ReadQuery,
  success: Schema.Unknown,
});

const OPERATIONS = [
  getPresentation,
  get("getPage", "/presentations/:presentationId/pages/:pageObjectId", {
    params: PageId,
    query: ReadQuery,
    success: Schema.Unknown,
  }),
  get("getThumbnail", "/presentations/:presentationId/pages/:pageObjectId/thumbnail", {
    params: PageId,
    query: {
      "thumbnailProperties.mimeType": Schema.optionalKey(Schema.String),
      "thumbnailProperties.thumbnailSize": Schema.optionalKey(Schema.String),
    },
    success: Schema.Unknown,
  }),
  post("createPresentation", "/presentations", { payload: Schema.Unknown, success: Schema.Unknown }),
  post("batchUpdate", "/presentations/:presentationId:batchUpdate", {
    params: PresentationId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
] as const;

export const SlidesApi = {
  ...vendor({ name: "Google Slides", manifestBase: "/v1" }, ...OPERATIONS),
  // Only exact public wire members that the projections navigate. A
  // private value matching one must not hide the member before projection;
  // every value and every other key still takes ordinary redaction.
  fixedKeys: {
    presentationId: "Presentation identity read by deck and create projections.",
    revisionId: "Deck or page revision read to bind continuation cursors.",
    locale: "Presentation locale read into the deck header.",
    pageSize: "Presentation dimensions container read by the deck header.",
    width: "Page or thumbnail width read by its projection.",
    height: "Page or thumbnail height read by its projection.",
    magnitude: "Dimension magnitude read before building the page-size projection.",
    unit: "Dimension or affine transform unit read for size and reading order.",
    slides: "Presentation slide array traversed by deck and comment projections.",
    layouts: "Presentation layout array traversed for layout names and comments.",
    masters: "Presentation master array traversed for layout rows and comments.",
    notesMaster: "Presentation notes master traversed for comment anchors.",
    objectId: "Page and element identity read by projections and cursor binding.",
    pageType: "Page type read by the page header.",
    slideProperties: "Slide properties traversed for layout, visibility and speaker notes.",
    layoutObjectId: "Slide layout reference read by page and slide projections.",
    masterObjectId: "Layout or slide master reference read for layout grouping.",
    isSkipped: "Slide visibility read by deck and page projections.",
    notesPage: "Speaker-notes page traversed by slide and comment projections.",
    notesProperties: "Speaker-notes properties traversed to locate the notes shape.",
    speakerNotesObjectId: "Speaker-notes element reference read to select notes text.",
    layoutProperties: "Layout properties traversed for names and master grouping.",
    masterProperties: "Master properties traversed for the displayed master name.",
    displayName: "Layout, master or comment-author display name read by projections.",
    pageElements: "Page elements traversed for reading order, raw paging and text protection.",
    transform: "Element affine transform traversed to calculate reading order.",
    scaleX: "Affine horizontal scale read when composing group transforms.",
    scaleY: "Affine vertical scale read when composing group transforms.",
    shearX: "Affine horizontal shear read when composing group transforms.",
    shearY: "Affine vertical shear read when composing group transforms.",
    translateX: "Affine horizontal translation read to order elements.",
    translateY: "Affine vertical translation read to order elements.",
    elementGroup: "Group container traversed before projecting its leaf elements.",
    children: "Group child array traversed recursively in reading order.",
    shape: "Shape container traversed to read its text and placeholder.",
    table: "Table container traversed to read cell text.",
    wordArt: "Word-art container traversed to read its rendered text.",
    renderedText: "Word-art text read before text reduction and paging.",
    image: "Image member inspected to classify a page element.",
    video: "Video member inspected to classify a page element.",
    sheetsChart: "Linked-chart member traversed to classify and identify its spreadsheet.",
    spreadsheetId: "Linked-chart spreadsheet identity read by the element projection.",
    line: "Line member inspected to classify and omit decorative elements.",
    placeholder: "Shape placeholder traversed for title detection and edit references.",
    index: "Placeholder index read by the projected page element.",
    parentObjectId: "Placeholder parent reference read by the projected page element.",
    textElements: "Text-element array traversed before joined text redaction.",
    textRun: "Text-run container traversed to read and protect its content.",
    autoText: "Automatic text container traversed beside ordinary text runs.",
    tableRows: "Table-row array traversed to build the table text projection.",
    tableCells: "Table-cell array traversed to build row text.",
    contentUrl: "Thumbnail link read by the bounded thumbnail projection.",
    writeControl: "Batch write-control container traversed to read the resulting revision.",
    requiredRevisionId: "Batch result revision read for the next guarded edit.",
    replies: "Batch replies or comment replies traversed by write and thread projections.",
    createSlide: "Create-slide reply traversed to recover the new slide identity.",
    replaceAllText: "Text-replacement reply traversed to read occurrence counts.",
    occurrencesChanged: "Text-replacement count read into the write result.",
    commentUpdateState: "Batch comment-save state read before reporting partial saves.",
    commentsViewMode: "Comment view mode checked before accepting complete thread reads.",
    comments: "Comment-thread array traversed for thread and raw projections.",
    commentAnchors: "Page comment-anchor array traversed to place threads.",
    anchorId: "Comment anchor identity read to join threads to page anchors.",
    objectAnchors: "Anchor target array traversed to locate commented elements.",
    commentId: "Thread identity read by thread projections and raw cursor framing.",
    headPost: "Thread head post traversed for author and content projection.",
    plainTextQuote: "Thread quote read before bounded comment paging.",
    status: "Comment-thread status read by the thread projection.",
    postId: "Comment-post identity read whole by comment projections.",
    author: "Comment author traversed for public identity and display fields.",
    user: "Comment-author user identity read whole by the post projection.",
    me: "Comment-author current-user flag read by the post projection.",
    anonymous: "Comment-author anonymity flag read by the post projection.",
    commentAction: "Comment-post action read before suppressing no-op actions.",
    assigneeEmail: "Comment-post assignee read into the bounded post projection.",
    createTime: "Comment-post creation time read into the bounded post projection.",
    updateTime: "Comment-post update time read into the bounded post projection.",
    deleted: "Comment-post deletion flag read by the post projection.",
    fromImportedPresentation: "Comment-post import flag read to explain missing author identity.",
    insertComment: "Insert-comment reply traversed to recover the new thread.",
    commentThread: "Insert-comment result traversed for its thread identity and posts.",
    addCommentReply: "Add-reply result traversed to recover the created post.",
    post: "Add-reply post container traversed for its identity and public fields.",
  },
};
export const errors = googleErrors(SLIDES);
export const safety = googleSafety(SLIDES.provider, OPERATIONS);

// Delegation has no operator credential to test, so this probe is never run.
export const probe = {
  operation: getPresentation,
  request: { params: { presentationsId: "-" } },
  describe: () => "Google Slides delegation has no credential to test.",
};
