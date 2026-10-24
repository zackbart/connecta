import { OperationIndex } from "../../_shared/rest/operation-index.js";
import { openapi } from "../openapi.generated.js";
import { googleBatchGuard, googleHatchBinding } from "../../_shared/google/hatch.js";
import type { Connection } from "../../../http/vendor.js";
import type { HatchDeclaration } from "../../../http/hatch.js";
import { REQUEST_KINDS } from "./requests.js";

export const DOCS_INDEX = new OperationIndex(openapi, {
  vendor: "docs",
  title: "Google Docs",
  pathMatching: "uri-template",
});
/** Literal execution allowlist. Schema inventory alone never admits an operation. */
export const DOCS_VERDICTS: HatchDeclaration["verdicts"] = {
  "GET /documents/{documentId}": "read",
  "POST /documents": "write",
  "POST /documents/{documentId}:batchUpdate": "destructive",
};
export function docsBinding(connection: Connection) {
  return googleHatchBinding(connection, {
    index: DOCS_INDEX,
    review:
      "All three frozen Docs methods; batch writes require a current revision and 1–100 reviewed GA request kinds. Preview comments and suggestions are refused.",
    refuse: (call) =>
      call.op.path.endsWith(":batchUpdate")
        ? googleBatchGuard(call.body, { kinds: REQUEST_KINDS, revision: true, max: 100 })
        : undefined,
    revisionGuarded: (call) =>
      call.op.path.endsWith(":batchUpdate") &&
      !googleBatchGuard(call.body, { kinds: REQUEST_KINDS, revision: true, max: 100 }),
  });
}
