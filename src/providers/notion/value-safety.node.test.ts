// Node-only: the shared value-safety harness reads the maintainer detection script in scripts/.
import candidates from "./value-safety.candidates.json";
import source from "./openapi.source.json";
import { openapi } from "./openapi.generated.js";
import { NOTION_VALUE_SAFETY } from "./value-safety.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { describeValueSafety } from "../../../test/fixtures/value-safety.js";
import { notion } from "./index.js";

const TOKEN = "ntn_value_safety";

describeValueSafety("Notion", {
  table: NOTION_VALUE_SAFETY,
  index: new OperationIndex(openapi, { vendor: "notion", title: "Notion" }),
  source,
  candidates,
  counts: { refuse: 3, redact: 0, safe: 8 },
  connector: () => notion("wiki", { purpose: "Team knowledge base", auth: { type: "token" } }),
  ctx: () => ({
    ...connectorContext(),
    credential: { get: async () => TOKEN, getAll: async () => ({ value: TOKEN }) },
  }),
  echo: {
    tool: "notion_api_read",
    args: { path: "/v1/file_uploads/fu_1" },
    respond: (marker) =>
      Response.json(
        { object: "error", code: "validation_error", message: `upload ${marker} rejected` },
        { status: 400 },
      ),
  },
});
