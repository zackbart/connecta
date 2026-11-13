// Gmail's declared operations are confined to the delegated user's own mailbox.
import { Effect, Schema } from "effect";
import { encodedFieldProvenance, get, post, put, type EncodedFieldProvenance } from "../../http/vendor.js";
import { googleErrors, type GoogleProduct } from "../_shared/google/kit.js";
import { indexedVendor } from "../_shared/rest/kit.js";
import { gmailSafety } from "./safety.js";
import { ConnectorCallError } from "../../errors.js";
import { GMAIL_SCOPES } from "./lib/constants.js";
import { index } from "./lib/index.js";

export const GMAIL: GoogleProduct = {
  provider: "Gmail",
  api: "Gmail API",
  scopes: GMAIL_SCOPES,
  // users/me confines every request to the token's own mailbox.
  notFound: "absent",
};

const Id = { id: Schema.String };
const Format = {
  format: Schema.optionalKey(Schema.String),
  metadataHeaders: Schema.optionalKey(Schema.Array(Schema.String)),
};
const Page = {
  q: Schema.optionalKey(Schema.String),
  maxResults: Schema.optionalKey(Schema.String),
  pageToken: Schema.optionalKey(Schema.String),
};
const listLabels = get("listLabels", "/labels", { success: Schema.Unknown });
const OPERATIONS = [
  get("listThreads", "/threads", {
    query: { ...Page, includeSpamTrash: Schema.optionalKey(Schema.String) },
    success: Schema.Unknown,
  }),
  get("getThread", "/threads/:id", {
    params: Id,
    query: Format,
    success: Schema.Unknown,
  }),
  get("getMessage", "/messages/:id", {
    params: Id,
    query: Format,
    success: Schema.Unknown,
  }),
  get("getAttachment", "/messages/:messageId/attachments/:id", {
    params: { messageId: Schema.String, ...Id },
    success: Schema.Unknown,
  }),
  listLabels,
  get("listMessages", "/messages", { query: Page, success: Schema.Unknown }),
  get("getLabel", "/labels/:id", { params: Id, success: Schema.Unknown }),
  get("getProfile", "/profile", { success: Schema.Unknown }),
  get("listHistory", "/history", { query: Page, success: Schema.Unknown }),
  get("listDrafts", "/drafts", { query: Page, success: Schema.Unknown }),
  get("getDraft", "/drafts/:id", {
    params: Id,
    query: Format,
    success: Schema.Unknown,
  }),
  post("createDraft", "/drafts", {
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  put("updateDraft", "/drafts/:id", {
    params: Id,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
] as const;

// The manifest uses Discovery's path; transport stays fixed beneath users/me.
const bodyPaths = [
  "payload",
  "message.payload",
  "messages[*].payload",
  "drafts[*].message.payload",
  "history[*].messages[*].payload",
  "history[*].messagesAdded[*].message.payload",
  "history[*].messagesDeleted[*].message.payload",
  "history[*].labelsAdded[*].message.payload",
  "history[*].labelsRemoved[*].message.payload",
].flatMap((prefix) =>
  // The normal MIME walk and a parsed forwarded-message walk each admit 20 levels.
  Array.from({ length: 41 }, (_, depth) => `${prefix}${".parts[*]".repeat(depth)}.body.data`),
);
const MANIFEST_BASE = "/gmail/v1/users/{userId}";
const indexed = indexedVendor("Gmail", index, OPERATIONS);
export const GmailApi = {
  ...indexed,
  manifestBase: MANIFEST_BASE,
  // Every indexed route has a literal hatch verdict, so the whole pinned inventory is declared.
  indexed: {
    ...indexed.indexed!,
    operations: index.ops.map((op) => `${op.method} ${MANIFEST_BASE}${op.path}`).sort(),
  },
  // Legacy body reads accept optional sizes. Attachment projection instead checks
  // originalLength against the fresh part's required size and the download's optional size.
  encodedFields: [
    ...bodyPaths,
    "data",
    "raw",
    "message.raw",
    "messages[*].raw",
    "drafts[*].message.raw",
    "history[*].messages[*].raw",
    "history[*].messagesAdded[*].message.raw",
    "history[*].messagesDeleted[*].message.raw",
    "history[*].labelsAdded[*].message.raw",
    "history[*].labelsRemoved[*].message.raw",
  ].map((path) => ({
    path,
    encoding: "base64url" as const,
    review: "Gmail's bounded MIME projection decodes this body or attachment data before rendering or byte encoding.",
  })),
};

const bodyProvenance = new WeakMap<object, EncodedFieldProvenance>();
/** Product-private metadata copied only by the result hook, before the projection validates attachment sizes. */
export const gmailBodyProvenance = (body: object): EncodedFieldProvenance | undefined => bodyProvenance.get(body);
const rawProvenance = new WeakMap<object, EncodedFieldProvenance>();
/** A `format=raw` message's original byte count and whether the sent-secret boundary changed it. */
export const gmailRawProvenance = (message: object): EncodedFieldProvenance | undefined => rawProvenance.get(message);
export const result = (body: unknown) =>
  Effect.sync(() => {
    const raw = encodedFieldProvenance(body, ["raw"]);
    if (raw && body !== null && typeof body === "object") rawProvenance.set(body, raw);
    const visit = (node: unknown, path: (string | number)[]) => {
      if (node === null || typeof node !== "object") return;
      const provenance = encodedFieldProvenance(body, [...path, "data"]);
      if (provenance) bodyProvenance.set(node, provenance);
      // A generic MIME read cannot expose an encoded lane beyond the reviewed
      // decoder paths. Named walks are bounded too, but hatch JSON keeps the whole graph.
      if (!provenance && typeof (node as Record<string, unknown>)["data"] === "string" && path.at(-1) === "body")
        throw new ConnectorCallError(
          "connector_call_failed",
          "Gmail returned MIME data beyond the reviewed nesting boundary.",
          { retryable: false },
        );
      for (const [key, child] of Object.entries(node))
        if (child !== null && typeof child === "object")
          visit(child, [...path, Array.isArray(node) ? Number(key) : key]);
    };
    visit(body, []);
    return body;
  });
const standardErrors = googleErrors(GMAIL, { standard: true });
export const errors: ReturnType<typeof googleErrors> = {
  ...standardErrors,
  meanings: {
    ...standardErrors.meanings!,
    conflicts: ["A thread changed before its content cursor"],
  },
};
export const safety = gmailSafety();
export const probe = {
  operation: listLabels,
  request: {},
  describe: () => "Gmail delegation has no credential to test.",
};
