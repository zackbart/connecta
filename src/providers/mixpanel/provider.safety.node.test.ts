// Node-only: the shared value-safety harness reads the maintainer detection script in scripts/.

import candidates from "./evidence/value-safety.json";
import { openapi } from "./openapi.generated.js";
import { MIXPANEL_VALUE_SAFETY } from "./safety.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { describeValueSafety } from "../../../test/fixtures/value-safety.js";
import { mixpanel } from "./index.js";

// The vendor publishes YAML; this source is the reviewed composite whose
// digest the compiled operation index carries. Per-document pins remain in
// drift.json. Candidates were produced by scripts/value-safety.mjs.
describeValueSafety("Mixpanel", {
  table: MIXPANEL_VALUE_SAFETY,
  index: new OperationIndex(openapi, { vendor: "mixpanel", title: "Mixpanel" }),
  source: { digest: openapi.digest, options: { valueSafety: true } },
  candidates,
  counts: { refuse: 0, redact: 0, safe: 9 },
  connector: () =>
    mixpanel("raw", { purpose: "Product reporting", via: "api", auth: { type: "credential" }, defaultProjectId: 42 }),
  ctx: () => ({
    ...connectorContext(),
    credential: {
      get: async () => "mp9Qx2.sa:pQ6?eT8+dW3=G5/f",
      getAll: async () => ({ value: "mp9Qx2.sa:pQ6?eT8+dW3=G5/f" }),
    },
  }),
  echo: {
    tool: "mixpanel_api_read",
    args: { path: "/api/app/me" },
    respond: (marker) => Response.json({ error: `Mixpanel rejected ${marker}` }, { status: 400 }),
  },
});
