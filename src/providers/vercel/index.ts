import { skill } from "./skill.generated.js";
/**
 * No `@vercel/sdk` on purpose — not a dependency and not an optional peer.
 * Direct fetch keeps the root Workers-safe and avoids shipping the SDK's
 * generated model graph. The token connector reads a pinned operation index
 * compiled from Vercel's published OpenAPI document (https://openapi.vercel.sh/,
 * unversioned, so pinned by content hash in `openapi.source.json`);
 * `npm run providers:check -- --provider vercel` reports when the live document
 * moves, and `src/providers/vercel/drift.json` also records the contract digest
 * of every endpoint a named tool is written against.
 */
import { apiConnector } from "../../connectors/api-connector.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import type { Connector, ToolClassification, ConnectorCallAdmissionPolicy } from "../../types.js";
import { keys, optionsOf, variants } from "../../config-schema.js";
import { CALL_ADMISSION, defineProvider, type ProviderContext } from "../../provider.js";
import { byAuth, hostedOAuth } from "../_shared/rest/dispatch.js";
import { restTools } from "../_shared/rest/tools.js";
import { VERCEL_API_BASE_URL, vercelRest } from "./rest.js";

export { VERCEL_API_BASE_URL } from "./rest.js";
/** Vercel's official hosted MCP endpoint. */
export const VERCEL_MCP_ENDPOINT = "https://mcp.vercel.com";

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
}

/**
 * Vercel's hosted MCP server over OAuth. Vercel admits only reviewed and
 * approved MCP clients, an operational gate outside Connecta.
 */
export interface VercelOAuthOptions extends VercelCommonOptions {
  auth: { type: "oauth" };
  /** Refused: the hosted server scopes by the teams the grant can reach. */
  teamId?: never;
  /** Refused: the hosted server has one endpoint. */
  baseUrl?: never;
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

export type VercelOptions = VercelOAuthOptions | VercelTokenOptions;

/**
 * Reviewed in #705's provider audit against https://vercel.com/docs/mcp/vercel-mcp/tools.
 * Retains the release-reviewed inventory, including names absent from today's
 * public reference. Live annotations were not reverified without credentials.
 * No schema digest is asserted without a captured schema to review. This
 * classifies the hosted OAuth catalog only; the REST connector annotates each
 * tool it authors.
 */
const VERCEL_MCP_CLASSIFICATION: ToolClassification = {
  tools: {
    "request_promote": {
      verdict: "destructive",
      reason:
        "The rolling-releases MCP reference promotes an existing deployment to production; replaces the authored REST promotion write.",
    },
    "list_project_domains": {
      verdict: "read",
      reason: "The projects MCP reference lists project-domain metadata; formerly the named REST read.",
    },
    "add_project_domain": {
      verdict: "destructive",
      reason: "Attaches a domain to a project; preserves the former REST write classification.",
    },
    "cancel_deployment": {
      verdict: "destructive",
      reason: "Cancels an existing deployment, even if the vendor claims read-only access.",
    },
    "upload_file": { verdict: "destructive", reason: "Uploads deployment file bytes and creates vendor state." },
    "create_deployment": {
      verdict: "destructive",
      reason: "Creates a preview or production deployment from Git or files.",
    },
    "list_deployment_events": {
      verdict: "read",
      reason: "Reads build events using the documented deployments catalog.",
    },
    "search_vercel_documentation": {
      "verdict": "read",
      "reason": "Retrieves Vercel vercel documentation information without changing vendor state.",
    },
    "list_teams": { "verdict": "read", "reason": "Retrieves Vercel teams information without changing vendor state." },
    "list_projects": {
      "verdict": "read",
      "reason": "Retrieves Vercel projects information without changing vendor state.",
    },
    "get_project": {
      "verdict": "read",
      "reason": "Retrieves Vercel project information without changing vendor state.",
    },
    "list_deployments": {
      "verdict": "read",
      "reason": "Retrieves Vercel deployments information without changing vendor state.",
    },
    "get_deployment": {
      "verdict": "read",
      "reason": "Retrieves Vercel deployment information without changing vendor state.",
    },
    "get_deployment_build_logs": {
      "verdict": "read",
      "reason": "Retrieves Vercel deployment build logs information without changing vendor state.",
    },
    "get_runtime_logs": {
      "verdict": "read",
      "reason": "Retrieves Vercel runtime logs information without changing vendor state.",
    },
    "get_runtime_errors": {
      "verdict": "read",
      "reason": "Retrieves Vercel runtime errors information without changing vendor state.",
    },
    "get_web_analytics": {
      "verdict": "read",
      "reason": "Retrieves Vercel web analytics information without changing vendor state.",
    },
    "list_agent_run_projects": {
      "verdict": "read",
      "reason": "Retrieves Vercel agent run projects information without changing vendor state.",
    },
    "list_agent_runs": {
      "verdict": "read",
      "reason": "Retrieves Vercel agent runs information without changing vendor state.",
    },
    "get_agent_run": {
      "verdict": "read",
      "reason": "Retrieves Vercel agent run information without changing vendor state.",
    },
    "get_agent_run_trace": {
      "verdict": "read",
      "reason": "Retrieves Vercel agent run trace information without changing vendor state.",
    },
    "check_domain_availability_and_price": {
      "verdict": "read",
      "reason": "Retrieves Vercel check domain availability and price information without changing vendor state.",
    },
    "get_purchase_quote": {
      "verdict": "read",
      "reason": "Reads a purchase quote; billing changes require a separate purchase tool.",
    },
    "get_domain_order": {
      "verdict": "read",
      "reason": "Retrieves Vercel domain order information without changing vendor state.",
    },
    "list_toolbar_threads": {
      "verdict": "read",
      "reason": "Retrieves Vercel toolbar threads information without changing vendor state.",
    },
    "get_toolbar_thread": {
      "verdict": "read",
      "reason": "Retrieves Vercel toolbar thread information without changing vendor state.",
    },
    "use_vercel_cli": {
      "verdict": "read",
      "reason": "Returns CLI guidance only; any subsequent CLI execution is outside this tool.",
    },
    "reply_to_toolbar_thread": {
      "verdict": "write",
      "reason": "reply to toolbar thread creates or appends Vercel state; it has side effects.",
    },
    "add_toolbar_reaction": {
      "verdict": "write",
      "reason": "add toolbar reaction creates or appends Vercel state; it has side effects.",
    },
    "deploy_to_vercel": {
      "verdict": "destructive",
      "reason": "Can change a live deployment and the project serving production traffic.",
    },
    "buy_pro": { "verdict": "destructive", "reason": "buy pro changes existing Vercel state or removes it." },
    "buy_credits": { "verdict": "destructive", "reason": "buy credits changes existing Vercel state or removes it." },
    "buy_addon": { "verdict": "destructive", "reason": "buy addon changes existing Vercel state or removes it." },
    "buy_domain": { "verdict": "destructive", "reason": "buy domain changes existing Vercel state or removes it." },
    "get_access_to_vercel_url": {
      "verdict": "destructive",
      "reason": "Creates an access grant; the returned access URL is a credential.",
    },
    "web_fetch_vercel_url": {
      "verdict": "destructive",
      "reason": "Invokes application code, whose side effects cannot be established from HTTP GET alone.",
    },
    "import-claude-design-from-url": {
      "verdict": "destructive",
      "reason": "Imports into a project and can change existing live project state.",
    },
    "change_toolbar_thread_resolve_status": {
      "verdict": "destructive",
      "reason": "change toolbar thread resolve status changes existing Vercel state or removes it.",
    },
    "edit_toolbar_message": {
      "verdict": "destructive",
      "reason": "edit toolbar message changes existing Vercel state or removes it.",
    },
    "filter_project_envs": {
      "verdict": "write",
      "reason":
        "Lists project environment variables and can return decrypted values; reviewed as a write so the pool trust policy gates the disclosure (#801).",
    },
    "get_project_env": {
      "verdict": "write",
      "reason":
        "Returns one environment variable's decrypted value; reviewed as a write so the pool trust policy gates the disclosure (#801).",
    },
    "create_project_env": {
      "verdict": "destructive",
      "reason": "Creates or overwrites project environment variables that future deployments embed.",
    },
    "edit_project_env": {
      "verdict": "destructive",
      "reason": "Replaces an existing environment variable's value or targets.",
    },
  },
};

function instructionsSection(instructions: string | undefined): string {
  const text = instructions?.trim();
  return text ? `\n## ${skill.instructionsHeading}\n\n${text}\n` : "";
}

function oauthUsageGuide(purpose: string, instructions: string | undefined): string {
  const { oauth, shared } = skill.fragments;
  return `# Vercel usage

Vercel's hosted MCP server over OAuth. Account purpose: ${purpose}${oauth}${shared}${instructionsSection(instructions)}`;
}

function tokenUsageGuide(purpose: string, teamId: string | undefined, instructions: string | undefined): string {
  const { key, shared } = skill.fragments;
  const scope = teamId
    ? `This connection defaults to team \`${teamId}\`: operations that accept a team get it unless a call passes \`teamId\` (or \`slug\`), and \`teamId: null\` targets the token owner's personal account.`
    : "This connection defaults to the token owner's personal account. Call `list_teams`, then pass `teamId` for team-owned resources.";
  return `# Vercel usage

Connecta's REST connector to the Vercel API with one access token. Account purpose: ${purpose}

${scope}${key}${shared}${instructionsSection(instructions)}`;
}

const COMMON = {
  ...keys("title", "authScope", "purpose", "instructions", "maxResultBytes"),
  callAdmission: CALL_ADMISSION,
};

/** The closed options vercel() accepts, selected by `auth.type`; see `assertKnownOptions`. */
const VERCEL_OPTIONS = variants(["auth", "type"], {
  // The never-typed keys stay out of the shape, so the walk refuses them by name.
  oauth: optionsOf<Omit<VercelOAuthOptions, "teamId" | "baseUrl">>()({
    ...COMMON,
    auth: optionsOf<VercelOAuthOptions["auth"]>()(keys("type")),
  }).shape,
  token: optionsOf<VercelTokenOptions>()({
    ...COMMON,
    ...keys("teamId", "baseUrl"),
    auth: optionsOf<VercelTokenOptions["auth"]>()(keys("type")),
  }).shape,
});

function vercelOAuth(id: string, options: Readonly<VercelOAuthOptions>, provider: ProviderContext): Connector {
  return hostedOAuth(id, provider, {
    url: VERCEL_MCP_ENDPOINT,
    title: options.title ?? "Vercel (MCP)",
    description: `Vercel's official hosted MCP surface: ${options.purpose}`,
    usageGuide: {
      content: oauthUsageGuide(options.purpose, options.instructions),
      summary: "Official MCP. Live Vercel schemas, id resolution, deployment diagnosis, purchases, and access grants.",
      required: true,
    },
  });
}

function vercelToken(id: string, options: Readonly<VercelTokenOptions>, provider: ProviderContext): Connector {
  const teamId = typeof options.teamId === "string" ? options.teamId.trim() || undefined : undefined;
  const baseUrl = options.baseUrl ?? VERCEL_API_BASE_URL;
  const rest = vercelRest({ baseUrl, teamId });
  return apiConnector(id, {
    ...provider.connectorOptions,
    title: options.title ?? "Vercel",
    description: `Vercel account and deployments: ${options.purpose}`,
    credential: {
      label: "Vercel access token",
      description:
        "Access token from Vercel Account Settings → Tokens. Choose the personal account or team scope this deployment needs and set an expiration date. The connector never sends it anywhere except api.vercel.com or the configured baseUrl proxy.",
      placeholder: "Paste Vercel access token",
    },
    testCredential: rest.testCredential,
    usageGuide: {
      content: tokenUsageGuide(options.purpose, teamId, options.instructions),
      summary: "One access token over REST: search operations, read details, then read or write. Value-safe env vars.",
      required: true,
    },
    tools: [...restTools(rest.vendor), ...rest.tools],
  });
}

/**
 * A maintained Vercel connection. `auth` selects the implementation: OAuth
 * reaches Vercel's hosted MCP server; an access token reaches Connecta's REST
 * connector to `api.vercel.com`.
 */
export const vercel = defineProvider<VercelOptions>({
  name: "vercel",
  title: "Vercel",
  kind: "dual",
  readme: "Vercel",
  bundle: {
    "baselineGzip": 228431,
    "maxGzip": 288431,
    "note":
      "./providers/vercel remeasures at 228,431 B gzip (#801), from a 143,649 B baseline recorded before the shared entry grew (shared code grew after it was recorded, as other entries measured before #801 show): auth now selects the implementation, so the entry carries the hosted MCP client and Connecta's REST connector (the shared REST module) plus the pinned Vercel operation index (445 operations; request details to depth 2, without descriptions or enums over 50 values; 26,274 B gzip as source; the reviewed value-safety table adds about 5 KB). Details were shrunk before the cap moved: descriptions alone added 15 KB gzip. The cap uses the existing baseline + 60,000 B policy.",
  },
  skill,
  options: VERCEL_OPTIONS,
  classify: VERCEL_MCP_CLASSIFICATION,
  create: byAuth<VercelOptions>({ oauth: vercelOAuth, token: vercelToken }),
});

/** @deprecated Read `vercel.definition.classify` instead. Kept for existing imports. */
export const VERCEL_MCP_VETTED_CATALOG = reviewedCatalog(vercel.definition.classify!, 'defineProvider("vercel")');
