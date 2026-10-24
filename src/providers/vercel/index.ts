import { keys, optionsOf, variants } from "../../config-schema.js";
import { defineApiProvider } from "../../http/provider.js";
import { CALL_ADMISSION } from "../../provider.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import { removedHostedMcp } from "../_shared/rest/dispatch.js";
import {
  authenticate,
  MAX_RESPONSE_BYTES,
  READ_CAP_MS,
  probe,
  result,
  safety,
  vercelErrors,
  VercelApi,
  usageGuide,
  VERCEL_VERDICTS,
  VERCEL_PAGES,
  vercelBinding,
  vercelIndex,
} from "./api.js";
import { VERCEL_API_BASE_URL } from "./lib/config.js";
import { vercelTools } from "./tools.js";
import { skill } from "./skill.generated.js";
export { VERCEL_API_BASE_URL } from "./lib/config.js";
interface VercelCommonOptions {
  /** Human-readable display name; defaults identify the implementation. */
  title?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Which Vercel account or team this connection operates, and for whom. */
  purpose: string;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Optional per-runtime downstream call-admission policy. */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
}

/**
 * Connecta's REST connector to `api.vercel.com` with one operator-managed
 * access token, pasted into the connection in the operator UI.
 */
export interface VercelTokenOptions extends VercelCommonOptions {
  auth: { type: "token" };
  /** Default team id for operations that accept one. Omit for the token owner's personal account. */
  teamId?: string;
  /** API base override for a proxy or test double. */
  baseUrl?: string;
}

export type VercelOptions = VercelTokenOptions;

const COMMON = {
  ...keys("title", "authScope", "purpose", "instructions", "maxResultBytes", "readOnly"),
  callAdmission: CALL_ADMISSION,
};

/** The closed options vercel() accepts, selected by `auth.type`; see `assertKnownOptions`. */
const VERCEL_OPTIONS = variants(
  ["auth", "type"],
  {
    // The never-typed keys stay out of the shape, so the walk refuses them by name.
    oauth: { ...COMMON, auth: optionsOf<{ type: "oauth" }>()(keys("type")) },
    token: optionsOf<VercelTokenOptions>()({
      ...COMMON,
      ...keys("teamId", "baseUrl"),
      auth: optionsOf<VercelTokenOptions["auth"]>()(keys("type")),
    }).shape,
  },
  undefined,
  ["oauth"],
);

/** Maintained API connection. Hosted MCP uses a separate generic connection. */
export const vercel = defineApiProvider<VercelOptions>({
  name: "vercel",
  title: "Vercel",
  readme: "Vercel",
  bundle: {
    baselineGzip: 423956,
    note: "./providers/vercel standalone gzip after decision 0011 step 2, Node 26.12.0, gzip level 9. Re-pinned response metadata, reviewed discovery prose, signed paging and bounded logs. The shared Effect kit is paid once per deployment; provider entries are reported, not capped (#899).",
  },
  skill,
  options: VERCEL_OPTIONS,
  vendor: VercelApi,
  baseUrl: (options) => {
    if (options.auth.type !== "token") removedHostedMcp();
    return options.baseUrl ?? VERCEL_API_BASE_URL;
  },
  description: (options) => `Vercel account and deployments: ${options.purpose}`,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  pageSize: { default: 20, max: 100 },
  idempotencyKey: false,
  timeoutMs: READ_CAP_MS,
  headers: { Accept: "application/json" },
  credential: {
    label: "Vercel access token",
    description:
      "Access token from Vercel Account Settings → Tokens. Choose the personal account or team scope this deployment needs and set an expiration date. The connector never sends it anywhere except api.vercel.com or the configured baseUrl proxy.",
    placeholder: "Paste Vercel access token",
  },
  authenticate,
  safety,
  errors: vercelErrors,
  result,
  inBandRefusals: true,
  probe,
  guide: usageGuide,
  hatch: {
    name: "vercel",
    title: "Vercel",
    index: vercelIndex,
    verdicts: VERCEL_VERDICTS,
    pages: VERCEL_PAGES,
    pathExample: "/v13/deployments/dpl_123",
    named: {
      "GET /v2/teams": "list_teams",
      "GET /v10/projects/{idOrName}/env": "list_project_env_vars",
      "POST /v10/projects/{idOrName}/env": "upsert_project_env_var",
      "PATCH /v9/projects/{idOrName}/env/{id}": "update_project_env_var",
      "GET /v3/deployments/{idOrUrl}/events": "get_deployment_build_logs",
      "GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs": "get_runtime_logs",
    },
    binding: vercelBinding,
    notes: () => ({
      read: "Pass page.nextCursor unchanged in the query parameter page.param names. Team selectors override the routing default; token permissions enforce scope.",
      write: "JSON writes only. Use vercel_api_upload for explicit bytes.",
    }),
  },
  tools: vercelTools,
});
