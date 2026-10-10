import { skill } from "./skill.generated.js";
import { apiConnector } from "../../connectors/api-connector.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import type { Connector, ToolClassification, ConnectorCallAdmissionPolicy } from "../../types.js";
import { keys, optionsOf, variants } from "../../config-schema.js";
import { CALL_ADMISSION, defineProvider, type ProviderContext } from "../../provider.js";
import { byAuth, hostedOAuth } from "../_shared/rest/dispatch.js";
import { MAX_PAGE_SIZE, notionRest } from "./rest.js";

export { NOTION_API_BASE_URL, NOTION_API_VERSION } from "./rest.js";

/** Notion's official hosted MCP endpoint. */
export const NOTION_MCP_ENDPOINT = "https://mcp.notion.com/mcp";

/** Lean by default: smaller than Notion's 100 so a first read stays cheap. */
const DEFAULT_PAGE_SIZE = 25;

/**
 * Notion documents "an average of three requests per second, with some bursts
 * beyond the average allowed" per connection. 180 calls per minute is that
 * average over a window short bursts pass and a sustained loop does not, and
 * `maxConcurrency: 3` is the load-bearing half — an averaged budget cannot stop
 * forty calls in one tick, and declaring a queue is also what makes the queue
 * settings legal at construction. Per runtime, and a floor on the real request
 * rate rather than a ceiling, since one admitted call can spend many fetches.
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
}

/**
 * Notion's official hosted MCP server, acting as the OAuth-authorized user.
 * OAuth only: no integration token reaches the hosted endpoint.
 */
export interface NotionOAuthOptions extends NotionCommonOptions {
  auth: { type: "oauth" };
  /** Optional per-runtime downstream call-admission policy. */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Refused: the hosted server holds no operator credential. */
  credentialLabel?: never;
  /** Refused: hosted tools own their own paging. */
  defaultPageSize?: never;
}

/**
 * Connecta's REST connector to `api.notion.com`, acting as one internal
 * integration with an operator-managed token pasted into the connection in
 * the operator UI.
 */
export interface NotionTokenOptions extends NotionCommonOptions {
  auth: { type: "token" };
  /** Operator-facing label for the integration token. */
  credentialLabel?: string;
  /**
   * Default `page_size` for the named list tools when the caller omits one.
   * Defaults to 25; Notion's maximum is 100.
   */
  defaultPageSize?: number;
}

/** `auth` selects the implementation: hosted MCP over OAuth, or REST with a token. */
export type NotionOptions = NotionOAuthOptions | NotionTokenOptions;

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

function oauthUsageGuide(purpose: string, instructions: string | undefined): string {
  const { oauth_head, oauth, shared } = skill.fragments;
  return `${oauth_head}${purpose}${oauth}${shared}${instructionsSection(instructions)}`;
}

/**
 * Reviewed in #705's provider audit against https://developers.notion.com/guides/mcp/mcp-supported-tools.
 * Retains the release-reviewed inventory, including names absent from today's
 * public reference. Live annotations were not reverified without credentials.
 * No schema digest is asserted without a captured schema to review.
 */
const NOTION_MCP_CLASSIFICATION: ToolClassification = {
  tools: {
    "notion-search": { "verdict": "read", "reason": "Retrieves Notion  information without changing vendor state." },
    "notion-search-skills": {
      "verdict": "read",
      "reason": "Retrieves Notion skills information without changing vendor state.",
    },
    "notion-fetch": {
      "verdict": "read",
      "reason": "Retrieves Notion fetch information without changing vendor state.",
    },
    "notion-download-attachment": {
      "verdict": "read",
      "reason": "Reads attachment content; creating uploads and attachments uses separate writes.",
    },
    "notion-query-data-sources": {
      "verdict": "read",
      "reason": "Retrieves Notion query data sources information without changing vendor state.",
    },
    "notion-query-meeting-notes": {
      "verdict": "read",
      "reason": "Retrieves Notion query meeting notes information without changing vendor state.",
    },
    "notion-search-agents": {
      "verdict": "read",
      "reason": "Retrieves Notion agents information without changing vendor state.",
    },
    "notion-list-agents": {
      "verdict": "read",
      "reason": "Retrieves Notion agents information without changing vendor state.",
    },
    "notion-query-sessions": {
      "verdict": "read",
      "reason": "Retrieves Notion query sessions information without changing vendor state.",
    },
    "notion-search-sessions": {
      "verdict": "read",
      "reason": "Retrieves Notion sessions information without changing vendor state.",
    },
    "notion-get-session-status": {
      "verdict": "read",
      "reason": "Retrieves Notion session status information without changing vendor state.",
    },
    "notion-wait-session": {
      "verdict": "read",
      "reason": "Waits for existing session state; it does not start or message a session.",
    },
    "notion-list-session-events": {
      "verdict": "read",
      "reason": "Retrieves Notion session events information without changing vendor state.",
    },
    "notion-read-session-event": {
      "verdict": "read",
      "reason": "Retrieves Notion read session event information without changing vendor state.",
    },
    "notion-get-comments": {
      "verdict": "read",
      "reason": "Retrieves Notion comments information without changing vendor state.",
    },
    "notion-get-teams": {
      "verdict": "read",
      "reason": "Retrieves Notion teams information without changing vendor state.",
    },
    "notion-get-users": {
      "verdict": "read",
      "reason": "Retrieves Notion users information without changing vendor state.",
    },
    "notion-get-async-task": {
      "verdict": "read",
      "reason": "Retrieves Notion async task information without changing vendor state.",
    },
    "notion-create-file-upload": { "verdict": "write", "reason": "Allocates upload state for a workspace file." },
    "notion-create-attachment": {
      "verdict": "write",
      "reason": "create attachment creates or appends Notion state; it has side effects.",
    },
    "notion-create-pages": {
      "verdict": "write",
      "reason": "create pages creates or appends Notion state; it has side effects.",
    },
    "notion-duplicate-page": {
      "verdict": "write",
      "reason": "duplicate page creates or appends Notion state; it has side effects.",
    },
    "notion-create-database": {
      "verdict": "write",
      "reason": "create database creates or appends Notion state; it has side effects.",
    },
    "notion-create-folder": {
      "verdict": "write",
      "reason": "create folder creates or appends Notion state; it has side effects.",
    },
    "notion-create-view": {
      "verdict": "write",
      "reason": "create view creates or appends Notion state; it has side effects.",
    },
    "notion-spawn-session": {
      "verdict": "write",
      "reason": "Starts asynchronous agent work and creates session state.",
    },
    "notion-send-message-to-session": {
      "verdict": "write",
      "reason": "Appends a message to a running session and may trigger further work.",
    },
    "notion-create-comment": {
      "verdict": "write",
      "reason": "create comment creates or appends Notion state; it has side effects.",
    },
    "notion-update-page": {
      "verdict": "destructive",
      "reason": "update page changes existing Notion state or removes it.",
    },
    "notion-convert-page-to-skill": {
      "verdict": "destructive",
      "reason": "Changes the role and content of an existing workspace page.",
    },
    "notion-move-pages": {
      "verdict": "destructive",
      "reason": "move pages changes existing Notion state or removes it.",
    },
    "notion-update-data-source": {
      "verdict": "destructive",
      "reason": "update data source changes existing Notion state or removes it.",
    },
    "notion-update-view": {
      "verdict": "destructive",
      "reason": "update view changes existing Notion state or removes it.",
    },
    "notion-stop-session": { "verdict": "destructive", "reason": "Stops an existing session and interrupts its work." },
  },
};

const COMMON = keys("title", "authScope", "purpose", "instructions", "maxResultBytes");

/** The closed options notion() accepts, selected by `auth.type`; see `assertKnownOptions`. */
const NOTION_OPTIONS = variants(["auth", "type"], {
  // The never-typed keys stay out of the shape, so the walk refuses them by name.
  oauth: optionsOf<Omit<NotionOAuthOptions, "credentialLabel" | "defaultPageSize">>()({
    ...COMMON,
    callAdmission: CALL_ADMISSION,
    auth: optionsOf<NotionOAuthOptions["auth"]>()(keys("type")),
  }).shape,
  token: optionsOf<NotionTokenOptions>()({
    ...COMMON,
    ...keys("credentialLabel", "defaultPageSize"),
    auth: optionsOf<NotionTokenOptions["auth"]>()(keys("type")),
  }).shape,
});

function notionOAuth(id: string, options: Readonly<NotionOAuthOptions>, provider: ProviderContext): Connector {
  return hostedOAuth(id, provider, {
    url: NOTION_MCP_ENDPOINT,
    title: options.title ?? "Notion (MCP)",
    description: `Notion's official hosted MCP interface: ${options.purpose}`,
    usageGuide: {
      content: oauthUsageGuide(options.purpose, options.instructions),
      summary: "Official MCP as the OAuth user. Live Notion schemas, object discovery, sessions, agents, attachments.",
      required: true,
    },
  });
}

function notionToken(id: string, options: Readonly<NotionTokenOptions>, provider: ProviderContext): Connector {
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(defaultPageSize) || defaultPageSize < 1 || defaultPageSize > MAX_PAGE_SIZE) {
    throw new Error(`notion() defaultPageSize must be a whole number between 1 and ${MAX_PAGE_SIZE}.`);
  }
  const rest = notionRest(defaultPageSize);
  return apiConnector(id, {
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
    callAdmission: NOTION_ADMISSION,
    usageGuide: {
      content: tokenUsageGuide(options.purpose, options.instructions),
      summary:
        "Internal integration over REST. Flattened reads, authoring helpers, and the pinned API index for the rest.",
      required: true,
    },
    tools: rest.tools,
  });
}

/**
 * A maintained Notion connection. `auth` selects the implementation: OAuth
 * reaches Notion's hosted MCP server as the authorizing user; an integration
 * token reaches Connecta's REST connector to `api.notion.com` as that bot.
 */
export const notion = defineProvider<NotionOptions>({
  name: "notion",
  title: "Notion",
  kind: "dual",
  readme: "Notion",
  bundle: {
    "baselineGzip": 211946,
    "maxGzip": 271946,
    "note":
      "./providers/notion remeasures at 211,946 B gzip (#801), against a 145,300 B baseline: auth now selects the implementation, so the entry carries the hosted MCP client and Connecta's REST connector (api(), the schema validator, guarded transport, the shared REST module) plus the pinned Notion operation index (64 operations; request details to depth 4, so block payload keys validate, with 160-character top-level descriptions; 14,240 B gzip as source). The index is already small, and removing eight one-operation named tools offset part of the shared module, so shrinking details further could not bring the entry under the old cap. The cap uses the existing baseline + 60,000 B policy.",
  },
  skill,
  options: NOTION_OPTIONS,
  classify: NOTION_MCP_CLASSIFICATION,
  create: byAuth<NotionOptions>({ oauth: notionOAuth, token: notionToken }),
});

/** @deprecated Read `notion.definition.classify` instead. Kept for existing imports. */
export const NOTION_MCP_VETTED_CATALOG = reviewedCatalog(notion.definition.classify!, 'defineProvider("notion")');
