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
    "baselineGzip": 228431,
    "note":
      "./providers/vercel was measured at 228,431 B gzip (#801), from a 143,649 B baseline recorded before the shared entry grew (shared code grew after it was recorded, as other entries measured before #801 show): that historical entry carried the hosted MCP client and Connecta's REST connector (the shared REST module) plus the pinned Vercel operation index (445 operations; request details to depth 2, without descriptions or enums over 50 values; 26,274 B gzip as source; the reviewed value-safety table adds about 5 KB). Details were shrunk before its former cap moved: descriptions alone added 15 KB gzip. C.0c removes the hosted half; this historical baseline remains for size comparison, not a cap (#899).",
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
  probe,
  guide: usageGuide,
  tools: vercelTools,
});
