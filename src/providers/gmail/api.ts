// Gmail's declared operations are confined to the delegated user's own mailbox.
import { Schema } from "effect";
import { get, post, put, vendor } from "../../http/vendor.js";
import { googleErrors, googleSafety, type GoogleProduct } from "../_shared/google/kit.js";
import { GMAIL_SCOPES } from "./lib/constants.js";

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
export const listLabels = get("listLabels", "/labels", { success: Schema.Unknown });
const OPERATIONS = [
  get("listThreads", "/threads", {
    query: { ...Page, includeSpamTrash: Schema.optionalKey(Schema.String) },
    success: Schema.Unknown,
  }),
  get("getThread", "/threads/:id", { params: Id, query: Format, success: Schema.Unknown }),
  get("getMessage", "/messages/:id", { params: Id, query: Format, success: Schema.Unknown }),
  get("getAttachment", "/messages/:messageId/attachments/:id", {
    params: { messageId: Schema.String, ...Id },
    success: Schema.Unknown,
  }),
  listLabels,
  get("listDrafts", "/drafts", { query: Page, success: Schema.Unknown }),
  get("getDraft", "/drafts/:id", { params: Id, query: Format, success: Schema.Unknown }),
  post("createDraft", "/drafts", { payload: Schema.Unknown, success: Schema.Unknown }),
  put("updateDraft", "/drafts/:id", { params: Id, payload: Schema.Unknown, success: Schema.Unknown }),
] as const;

// The manifest uses Discovery's path; transport stays fixed beneath users/me.
export const GmailApi = vendor({ name: "Gmail", manifestBase: "/gmail/v1/users/{userId}" }, ...OPERATIONS);
export const errors = googleErrors(GMAIL);
export const safety = googleSafety(GMAIL.provider, OPERATIONS);
export const probe = {
  operation: listLabels,
  request: {},
  describe: () => "Gmail delegation has no credential to test.",
};
