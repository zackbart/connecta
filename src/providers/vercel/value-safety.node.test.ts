// Node-only: the shared value-safety harness reads the maintainer detection script in scripts/.
import candidates from "./value-safety.candidates.json";
import source from "./openapi.source.json";
import { openapi } from "./openapi.generated.js";
import { VERCEL_VALUE_SAFETY } from "./value-safety.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { describeValueSafety } from "../../../test/fixtures/value-safety.js";
import { vercel } from "./index.js";

describeValueSafety("Vercel", {
  table: VERCEL_VALUE_SAFETY,
  index: new OperationIndex(openapi, { vendor: "vercel", title: "Vercel" }),
  source,
  candidates,
  counts: { refuse: 25, redact: 53, safe: 63 },
  connector: () => vercel("hosting", { purpose: "Apps", auth: { type: "token" } }),
  ctx: () => ({
    ...connectorContext(),
    credential: { get: async () => "tok", getAll: async () => ({ value: "tok" }) },
  }),
  echo: {
    tool: "vercel_api_read",
    args: { path: "/v1/drains/d1" },
    respond: (marker) =>
      Response.json({ error: { code: "bad_request", message: `drain secret ${marker} rejected` } }, { status: 400 }),
  },
});
