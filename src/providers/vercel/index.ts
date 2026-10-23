import { skill } from "./skill.generated.js";
/**
 * No `@vercel/sdk` on purpose — not a dependency and not an optional peer.
 * Direct fetch keeps the root Workers-safe and avoids shipping the SDK's
 * generated model graph. The token connector reads a pinned operation index
 * compiled from Vercel's published OpenAPI document (https://openapi.vercel.sh/,
 * unversioned, so pinned by content hash in `openapi.source.json`);
 * `pnpm run providers:check --provider vercel` reports when the live document
 * moves, and `src/providers/vercel/drift.json` also records the contract digest
 * of every endpoint a named tool is written against.
 */
import { keys, optionsOf, variants } from "../../config-schema.js";
import { apiConnector } from "../../connectors/api-connector.js";
import { tracksEveryRequest } from "../../provider-call.js";
import { CALL_ADMISSION, defineProvider, type ProviderContext } from "../../provider.js";
import type { Connector, ConnectorCallAdmissionPolicy } from "../../types.js";
import { byAuth, removedHostedMcp } from "../_shared/rest/dispatch.js";
import { restTools } from "../_shared/rest/tools.js";
import { VERCEL_API_BASE_URL, vercelRest } from "./rest.js";

export { VERCEL_API_BASE_URL } from "./rest.js";

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

function instructionsSection(instructions: string | undefined): string {
  const text = instructions?.trim();
  return text ? `\n## ${skill.instructionsHeading}\n\n${text}\n` : "";
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

function vercelToken(id: string, options: Readonly<VercelTokenOptions>, provider: ProviderContext): Connector {
  const teamId = typeof options.teamId === "string" ? options.teamId.trim() || undefined : undefined;
  const baseUrl = options.baseUrl ?? VERCEL_API_BASE_URL;
  const rest = vercelRest({ baseUrl, teamId });
  return tracksEveryRequest(
    apiConnector(id, {
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
        summary:
          "One access token over REST: search operations, read details, then read or write. Value-safe env vars.",
        required: true,
      },
      tools: [...restTools(rest.vendor), ...rest.tools],
    }),
  );
}

/** Maintained API connection. Hosted MCP uses a separate generic remoteMcp() entry. */
export const vercel = defineProvider<VercelOptions>({
  name: "vercel",
  title: "Vercel",
  kind: "api",
  readme: "Vercel",
  bundle: {
    "baselineGzip": 228431,
    "note":
      "./providers/vercel was measured at 228,431 B gzip (#801), from a 143,649 B baseline recorded before the shared entry grew (shared code grew after it was recorded, as other entries measured before #801 show): that historical entry carried the hosted MCP client and Connecta's REST connector (the shared REST module) plus the pinned Vercel operation index (445 operations; request details to depth 2, without descriptions or enums over 50 values; 26,274 B gzip as source; the reviewed value-safety table adds about 5 KB). Details were shrunk before its former cap moved: descriptions alone added 15 KB gzip. C.0c removes the hosted half; this historical baseline remains for size comparison, not a cap (#899).",
  },
  skill,
  options: VERCEL_OPTIONS,
  create: byAuth<VercelOptions>({ oauth: removedHostedMcp, token: vercelToken }),
});
