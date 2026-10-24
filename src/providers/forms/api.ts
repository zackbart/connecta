// Google Forms' vendor on the provider kit (C.7 step 1): the operations the
// tools send, the product facts the shared Google table words its failures
// with, and the value-safety resolver over those operations.
import { Schema } from "effect";
import { get, post, vendor } from "../../http/vendor.js";
import { googleErrors, type GoogleProduct } from "../_shared/google/kit.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { formsIndex } from "./lib/hatch.js";
import { FORMS_VALUE_SAFETY } from "./safety.js";
import { FORMS_SCOPES } from "./lib/constants.js";

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

export const errors = googleErrors(FORMS, { standard: true, revisionConflicts: true });

const values = valueSafety(FORMS_VALUE_SAFETY, () => formsIndex);
export const safety = {
  reviewed: {
    resolve: (method: string, path: string) => {
      const op = formsIndex.resolve(method, path).op;
      return { method: op.method, template: op.path };
    },
    redact: (data: unknown, op: { method: string; template: string }) => values.redact(data, op.method, op.template),
    withholdsErrors: (op: { method: string; template: string }) =>
      values.withholdsErrors(formsIndex.ops.find((entry) => entry.method === op.method && entry.path === op.template)!),
  },
  sensitiveFields: { names: [], choice: "drop" },
} as const;

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
