import { googlePageToken } from "../../../http/hatch-paging.js";
import { googleBatchGuard, googleHatchBinding } from "../../_shared/google/hatch.js";
import { OperationIndex } from "../../_shared/rest/operation-index.js";
import type { Connection } from "../../../http/vendor.js";
import { openapi } from "../openapi.generated.js";

export const formsIndex = new OperationIndex(openapi, {
  vendor: "forms",
  title: "Google Forms",
  pathMatching: "uri-template",
});
export const FORMS_REQUEST_KINDS = [
  "createItem",
  "updateItem",
  "deleteItem",
  "moveItem",
  "updateFormInfo",
  "updateSettings",
] as const;
export const FORMS_REFUSALS: Readonly<Record<string, string>> = {
  "POST /forms/{formId}:setPublishSettings":
    "Publishing and response availability changes require separate product authorization; the owner can change them in Forms.",
  "POST /forms/{formId}/watches":
    "Watch registration creates persistent Pub/Sub delivery and requires separate product authorization.",
  "GET /forms/{formId}/watches":
    "Watch administration is outside this connection; manage watches through the approved operator workflow.",
  "POST /forms/{formId}/watches/{watchId}:renew":
    "Watch renewal extends persistent Pub/Sub delivery and requires separate product authorization.",
  "DELETE /forms/{formId}/watches/{watchId}":
    "Watch administration is outside this connection; manage watches through the approved operator workflow.",
};
export function formsBinding(connection: Connection) {
  return googleHatchBinding(connection, {
    index: formsIndex,
    review:
      "Five reviewed Forms JSON methods, confined below /v1 with delegated subject, shared safety and revision-checked batches; publish settings and watches refused.",
    refuse: (call) => {
      const refusal = FORMS_REFUSALS[`${call.method} ${call.op.path}`];
      if (refusal) return refusal;
      const pageSize = call.query["pageSize"];
      if (
        call.op.path === "/forms/{formId}/responses" &&
        pageSize !== undefined &&
        (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5000)
      )
        return "Forms query.pageSize must be an integer from 1 to 5000; omit it for the default.";
      return call.op.path === "/forms/{formId}:batchUpdate"
        ? googleBatchGuard(call.body, { kinds: FORMS_REQUEST_KINDS, revision: true })
        : undefined;
    },
    revisionGuarded: (call) => call.op.path === "/forms/{formId}:batchUpdate",
  });
}
export const FORMS_HATCH = {
  name: "forms",
  title: "Google Forms",
  index: formsIndex,
  pathExample: "/forms/form_123",
  verdicts: {
    "GET /forms/{formId}": "read",
    "POST /forms": "write",
    "POST /forms/{formId}:batchUpdate": "destructive",
    "GET /forms/{formId}/responses": "read",
    "GET /forms/{formId}/responses/{responseId}": "read",
    "POST /forms/{formId}:setPublishSettings": "refuse",
    "POST /forms/{formId}/watches": "refuse",
    "GET /forms/{formId}/watches": "refuse",
    "POST /forms/{formId}/watches/{watchId}:renew": "refuse",
    "DELETE /forms/{formId}/watches/{watchId}": "refuse",
  },
  named: {
    "GET /forms/{formId}": "get_form",
    "POST /forms": "create_form",
    "POST /forms/{formId}:batchUpdate": "batch_update_form",
    "GET /forms/{formId}/responses": "list_responses",
    "GET /forms/{formId}/responses/{responseId}": "get_response",
  },
  pages: { "GET /forms/{formId}/responses": googlePageToken },
  pageCursor: "argument",
} as const;
