// Google Forms' vendor on the provider kit (C.7 step 1): the operations the
// tools send, the product facts the shared Google table words its failures
// with, and the value-safety resolver over those operations.
import { Schema } from "effect";
import { get, post, vendor } from "../../http/vendor.js";
import { googleErrors, googleSafety, type GoogleProduct } from "../_shared/google/kit.js";

/**
 * The Forms API root. Every path the tools send sits beneath `/forms`; there
 * is no user segment, because a form is a Drive file the token's subject can
 * or cannot open.
 */
export const FORMS_API_BASE_URL = "https://forms.googleapis.com/v1";

/**
 * Exactly the scopes this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list (comma-separated there).
 * `forms.body` reads and edits forms; responses are read-only.
 */
export const FORMS_SCOPES = [
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/forms.responses.readonly",
] as const;

/** A large form with embedded media metadata, or a page of long answers. */
export const FORMS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export const FORMS: GoogleProduct = {
  provider: "Google Forms",
  api: "Google Forms API",
  scopes: FORMS_SCOPES,
  // A form is a Drive file: Google answers 404 alike for one that does not
  // exist and one this user cannot open, so a 404 is not proof of absence.
  notFound: "ambiguous",
};

const FormId = { formId: Schema.String };

export const getForm = get("getForm", "/forms/:formId", { params: FormId, success: Schema.Unknown });

const OPERATIONS = [
  getForm,
  post("createForm", "/forms", {
    query: { unpublished: Schema.optionalKey(Schema.String) },
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("batchUpdate", "/forms/:formId:batchUpdate", {
    params: FormId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  get("listResponses", "/forms/:formId/responses", {
    params: FormId,
    query: {
      filter: Schema.optionalKey(Schema.String),
      pageSize: Schema.optionalKey(Schema.String),
      pageToken: Schema.optionalKey(Schema.String),
    },
    success: Schema.Unknown,
  }),
  get("getResponse", "/forms/:formId/responses/:responseId", {
    params: { ...FormId, responseId: Schema.String },
    success: Schema.Unknown,
  }),
] as const;

/** The five Forms methods the tools call, published under `/v1` as Google's Discovery document spells them. */
export const FormsApi = vendor({ name: "Google Forms", manifestBase: "/v1" }, ...OPERATIONS);

export const errors = googleErrors(FORMS);

export const safety = googleSafety(FORMS.provider, OPERATIONS);

/**
 * Delegation has no operator credential to test: the key is a deployment
 * secret read at construction. This probe is never run, because the
 * connection declares no credential.
 */
export const probe = {
  operation: getForm,
  request: { params: { formId: "-" } },
  describe: () => "Google Forms delegation has no credential to test.",
};
