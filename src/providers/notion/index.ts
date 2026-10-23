import { keys, optionsOf, variants } from "../../config-schema.js";
import { apiConnector } from "../../connectors/api-connector.js";
import { tracksEveryRequest } from "../../provider-call.js";
import { CALL_ADMISSION, defineProvider, type ProviderContext } from "../../provider.js";
import type { Connector, ConnectorCallAdmissionPolicy } from "../../types.js";
import { byAuth, removedHostedMcp } from "../_shared/rest/dispatch.js";
import { MAX_PAGE_SIZE, notionRest } from "./rest.js";
import { skill } from "./skill.generated.js";

export { NOTION_API_BASE_URL, NOTION_API_VERSION } from "./rest.js";

/** Lean by default: smaller than Notion's 100 so a first read stays cheap. */
const DEFAULT_PAGE_SIZE = 25;

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

function instructionsSection(instructions: string | undefined): string {
  const text = instructions?.trim();
  return text ? `\n## ${skill.instructionsHeading}\n\n${text}\n` : "";
}

/**
 * Both guides are marked `required` for one reason: a Notion database is a
 * container, and the rows and schema live in a data source inside it. The id
 * in a database URL is a database id, and passing it to a query or a row
 * create fails — a trap no input schema can teach, so the guide has to.
 */
function tokenUsageGuide(purpose: string, instructions: string | undefined): string {
  const { key, shared } = skill.fragments;
  return `# Notion usage

Workspace purpose: ${purpose}${key}${shared}${instructionsSection(instructions)}`;
}

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

function notionToken(id: string, options: Readonly<NotionTokenOptions>, provider: ProviderContext): Connector {
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(defaultPageSize) || defaultPageSize < 1 || defaultPageSize > MAX_PAGE_SIZE) {
    throw new Error(`notion() defaultPageSize must be a whole number between 1 and ${MAX_PAGE_SIZE}.`);
  }
  const rest = notionRest(defaultPageSize);
  return tracksEveryRequest(
    apiConnector(id, {
      ...provider.connectorOptions,
      title: options.title ?? "Notion integration",
      description: `Notion internal integration: ${options.purpose}`,
      credential: {
        label: options.credentialLabel ?? "Notion integration token",
        description:
          "Internal integration token from notion.so/profile/integrations. Every page or database the agent should reach must also be shared with that integration, and its capabilities decide which tools succeed — comment capabilities are off by default.",
        placeholder: "Paste the integration token",
      },
      testCredential: rest.testCredential,
      callAdmission: options.callAdmission === undefined ? NOTION_ADMISSION : options.callAdmission,
      usageGuide: {
        content: tokenUsageGuide(options.purpose, options.instructions),
        summary:
          "Internal integration over REST. Flattened reads, authoring helpers, and the pinned API index for the rest.",
        required: true,
      },
      tools: rest.tools,
    }),
  );
}

/** Maintained API connection. Hosted MCP uses a separate generic remoteMcp() entry. */
export const notion = defineProvider<NotionOptions>({
  name: "notion",
  title: "Notion",
  kind: "api",
  readme: "Notion",
  bundle: {
    "baselineGzip": 211946,
    "note":
      "./providers/notion was measured at 211,946 B gzip (#801), against a 145,300 B baseline: that historical entry carried the hosted MCP client and Connecta's REST connector (api(), the schema validator, guarded transport, the shared REST module) plus the pinned Notion operation index (64 operations; request details to depth 4, so block payload keys validate, with 160-character top-level descriptions; 14,240 B gzip as source). The index is already small, and removing eight one-operation named tools offset part of the shared module, so shrinking details further could not bring the entry under the old cap. C.0c removes the hosted half; this historical baseline remains for size comparison, not a cap (#899).",
  },
  skill,
  options: NOTION_OPTIONS,
  create: byAuth<NotionOptions>({ oauth: removedHostedMcp, token: notionToken }),
});
