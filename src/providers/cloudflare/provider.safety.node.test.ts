// Node-only: the shared value-safety harness reads the maintainer detection script in scripts/.
import candidates from "./evidence/value-safety.json";
import source from "./evidence/openapi.json";
import { openapi } from "./openapi.generated.js";
import { CLOUDFLARE_VALUE_SAFETY } from "./safety.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { describeValueSafety } from "../../../test/fixtures/value-safety.js";
import { cloudflare } from "./index.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";

describeValueSafety("Cloudflare", {
  table: CLOUDFLARE_VALUE_SAFETY,
  index: new OperationIndex(openapi, { vendor: "cloudflare", title: "Cloudflare" }),
  source,
  candidates,
  counts: { refuse: 61, redact: 268, safe: 482 },
  // Reviewed operation paths are relative to result; the provider also scans the
  // outer envelope before retaining its safe metadata.
  dataPath: (field) => {
    if (/^(?:result_info|messages|errors|success)\b/.test(field)) return undefined;
    const data = field.replace(/^result(?:\[\])?(?=\.|\{|$)/, "").replace(/^\./, "");
    return data === "{}" ? "" : data;
  },
  connector: () => cloudflare("cf", { purpose: "Production DNS and Workers", auth: { type: "apiToken" } }),
  ctx: () => ({
    ...connectorContext(),
    credential: { get: async () => "cf-token-123", getAll: async () => ({ value: "cf-token-123" }) },
  }),
  fill: (template) =>
    template
      .replace(/\{account_id\}|\{account_tag\}/g, ACCOUNT)
      .replace(/\{zone_id\}/g, ZONE)
      .replace(/\{[^}]+\}/g, "x1"),
  echo: {
    tool: "cloudflare_api_read",
    args: { path: `/accounts/${ACCOUNT}/challenges/widgets/0x4AAA` },
    respond: (marker) =>
      Response.json(
        { success: false, errors: [{ code: 10001, message: `secret ${marker} rejected` }] },
        { status: 400 },
      ),
  },
});
