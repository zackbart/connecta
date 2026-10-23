import { keys, optionsOf, variants } from "../../config-schema.js";
import { defineApiProvider } from "../../http/provider.js";
import { CALL_ADMISSION } from "../../provider.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import { removedHostedMcp } from "../_shared/rest/dispatch.js";
import {
  authenticate,
  DEFAULT_PAGE_SIZE,
  errors,
  MAX_PAGE_SIZE,
  NOTION_API_BASE_URL,
  NOTION_API_VERSION,
  NOTION_MAX_RESPONSE_BYTES,
  NotionApi,
  probe,
  result,
  safety,
  usageGuide,
} from "./api.js";
import { notionTools } from "./tools.js";
import { skill } from "./skill.generated.js";

export { NOTION_API_BASE_URL, NOTION_API_VERSION };

/**
 * Conservative default for every Notion plan: 180 calls per minute, with
 * Connecta's concurrency cap of three to bound bursts. Business and Enterprise
 * allow 600 requests per minute per connection; all connections also share a
 * workspace-wide limit. This policy is per runtime and counts calls rather
 * than HTTP requests, since one admitted call can spend many fetches.
 */
const NOTION_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      maxConcurrency: 3,
      budget: { kind: "rolling-window", maxCalls: 180, windowMs: 60_000 },
      maxQueueSize: 32,
      queueTimeoutMs: 5_000,
      retryAfterMs: 1_000,
    },
  ],
};

interface NotionCommonOptions {
  /** Human-readable display name; defaults identify the selected implementation. */
  title?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Which workspace this is and what it should be used for. Required. */
  purpose: string;
  /** Workspace-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
}

/**
 * Connecta's REST connector to `api.notion.com`, acting as one internal
 * integration with an operator-managed token pasted into the connection in
 * the operator UI.
 */
export interface NotionTokenOptions extends NotionCommonOptions {
  auth: { type: "token" };
  /**
   * Per-runtime downstream call-admission policy, replacing the default of
   * 180 calls/minute and 3 concurrent. Business and Enterprise allow 600
   * requests/minute per connection; all connections share a workspace-wide
   * limit. One admitted call can make several HTTP requests.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Operator-facing label for the integration token. */
  credentialLabel?: string;
  /**
   * Default `page_size` for the named list tools when the caller omits one.
   * Defaults to 25; Notion's maximum is 100.
   */
  defaultPageSize?: number;
}

/** Notion's maintained REST connector uses integration-token auth. */
export type NotionOptions = NotionTokenOptions;

const COMMON = keys("title", "authScope", "purpose", "instructions", "maxResultBytes", "readOnly");

/** The closed options notion() accepts, selected by `auth.type`; see `assertKnownOptions`. */
const NOTION_OPTIONS = variants(
  ["auth", "type"],
  {
    // The never-typed keys stay out of the shape, so the walk refuses them by name.
    oauth: { ...COMMON, callAdmission: CALL_ADMISSION, auth: optionsOf<{ type: "oauth" }>()(keys("type")) },
    token: optionsOf<NotionTokenOptions>()({
      ...COMMON,
      callAdmission: CALL_ADMISSION,
      ...keys("credentialLabel", "defaultPageSize"),
      auth: optionsOf<NotionTokenOptions["auth"]>()(keys("type")),
    }).shape,
  },
  undefined,
  ["oauth"],
);

/** Maintained API connection. Hosted MCP uses a separate generic connection. */
export const notion = defineApiProvider<NotionOptions>({
  name: "notion",
  title: "Notion",
  readme: "Notion",
  bundle: {
    "baselineGzip": 211946,
    "note":
      "./providers/notion was measured at 211,946 B gzip (#801), against a 145,300 B baseline: that historical entry carried the hosted MCP client and Connecta's REST connector (api(), the schema validator, guarded transport, the shared REST module) plus the pinned Notion operation index (64 operations; request details to depth 4, so block payload keys validate, with 160-character top-level descriptions; 14,240 B gzip as source). The index is already small, and removing eight one-operation named tools offset part of the shared module, so shrinking details further could not bring the entry under the old cap. C.0c removes the hosted half; this historical baseline remains for size comparison, not a cap (#899).",
  },
  skill,
  options: NOTION_OPTIONS,
  displayTitle: () => "Notion integration",
  description: (options) => `Notion internal integration: ${options.purpose}`,
  vendor: NotionApi,
  baseUrl: (options) => {
    if (options.auth.type !== "token") return removedHostedMcp();
    return NOTION_API_BASE_URL;
  },
  headers: { "Notion-Version": NOTION_API_VERSION },
  maxResponseBytes: NOTION_MAX_RESPONSE_BYTES,
  timeoutMs: 60_000,
  pageSize: { default: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE },
  defaultCallAdmission: NOTION_ADMISSION,
  credential: (options) => ({
    label: options.credentialLabel ?? "Notion integration token",
    description:
      "Internal integration token from notion.so/profile/integrations. Every page or database the agent should reach must also be shared with that integration, and its capabilities decide which tools succeed — comment capabilities are off by default.",
    placeholder: "Paste the integration token",
  }),
  authenticate,
  errors,
  safety: () => safety,
  result,
  probe,
  guide: usageGuide,
  tools: notionTools,
});
