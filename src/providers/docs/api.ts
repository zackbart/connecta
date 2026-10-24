// Google Docs' vendor on the provider kit (C.7 step 1).
import { Schema } from "effect";
import { get, post, vendor } from "../../http/vendor.js";
import type { VendorErrors } from "../../http/errors.js";
import { googleErrors, type GoogleProduct, type GoogleFacts } from "../_shared/google/kit.js";
import { docsSafety } from "./safety.js";
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
export const DocsApi = vendor({ name: "Google Docs", manifestBase: "/v1" }, ...OPERATIONS);
const standardErrors = googleErrors(DOCS, { standard: true, revisionConflicts: true });
export const errors: VendorErrors<GoogleFacts> = {
  ...standardErrors,
  meanings: {
    ...standardErrors.meanings!,
    conflicts: [
      ...standardErrors.meanings!.conflicts.map((meaning) => meaning.replace(/\.$/, "")),
      "The document content or revision changed during indexed content paging",
    ],
  },
};
export const safety = docsSafety(OPERATIONS);

/** Delegation has no operator credential to test; this probe is never run. */
export const probe = {
  operation: getDocument,
  request: { params: { documentId: "-" } },
  describe: () => "Google Docs delegation has no credential to test.",
};
