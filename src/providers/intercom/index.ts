import { remoteMcp, withCredentialDefaults, type RemoteMcpAuth } from "../../connectors/remote-mcp.js";
import { keys, optionsOf } from "../../config-schema.js";
import { REMOTE_MCP_AUTH } from "../../connectors/option-shapes.js";
import { defineProvider, PROVIDER_COMMON, type ProviderOptions } from "../../provider.js";
import type { ToolClassification } from "../../types.js";
import { skill } from "./skill.generated.js";

/** AU hosted workspaces are not supported by Intercom's MCP server. */
export type IntercomRegion = "us" | "eu";

/** Reviewed Streamable HTTP endpoints; never route EU workspace data through US. */
export const INTERCOM_MCP_ENDPOINTS: Readonly<Record<IntercomRegion, string>> = {
  us: "https://mcp.intercom.com/mcp",
  eu: "https://mcp.eu.intercom.com/mcp",
};

export interface IntercomOptions extends ProviderOptions {
  /** Required: match the workspace's hosted region. AU is unavailable. */
  region: IntercomRegion;
  /**
   * Defaults to OAuth with dynamic registration and discovered scopes (mcp,
   * operator). Non-loopback OAuth callbacks need Intercom's allowlist approval.
   * A credential sends an operator-managed API token as Authorization: Bearer.
   * Fin Operator tools require teammate OAuth and are unavailable to API tokens.
   */
  auth?: RemoteMcpAuth;
  /**
   * Defaults to personal for OAuth, shared for an explicitly supplied token.
   * OAuth runs with the authorizing teammate's permissions and seat rules.
   */
  authScope?: "shared" | "personal";
}

/**
 * Official-document review, 2026-10-19: 14 core tools and five optional Fin
 * Operator tools. Both regions refuse anonymous tools/list (401); no schemas
 * or schema digests are fabricated. Live tools/list owns schemas and results.
 */
const CLASSIFICATION: ToolClassification = {
  tools: {
    search: { verdict: "read", reason: "Searches existing conversations or contacts through the query DSL." },
    fetch: { verdict: "read", reason: "Retrieves an existing conversation, contact or company by its prefixed id." },
    search_conversations: { verdict: "read", reason: "Filters existing conversations without changing their state." },
    get_conversation: { verdict: "read", reason: "Reads a conversation, its parts and metadata." },
    search_contacts: { verdict: "read", reason: "Filters existing contacts without modifying their profiles." },
    get_contact: { verdict: "read", reason: "Reads an existing contact's attributes, location and activity." },
    list_companies: { verdict: "read", reason: "Lists or filters existing companies." },
    get_company: { verdict: "read", reason: "Reads an existing company, its attributes, segments and tags." },
    list_articles: { verdict: "read", reason: "Lists existing Help Center articles." },
    search_articles: { verdict: "read", reason: "Searches existing Help Center articles." },
    get_article: { verdict: "read", reason: "Reads an existing article's HTML body and metadata." },
    create_article: { verdict: "write", reason: "Creates a Help Center article, potentially published immediately." },
    update_article: {
      verdict: "destructive",
      reason: "Overwrites fields, content or publication state on an existing article.",
    },
    add_internal_note: {
      verdict: "destructive",
      reason: "Appends a teammate-only note and may unsnooze an existing conversation, changing its state to open.",
    },
    // Fin tools are OAuth-only and gated by workspace availability and teammate
    // permission: https://developers.intercom.com/docs/guides/fin-operator-mcp#how-permissions-work
    send_operator_message: {
      optional: true,
      verdict: "destructive",
      reason:
        "Starts asynchronous Operator work and consumes usage; Intercom explicitly marks this destructive and non-idempotent.",
    },
    get_operator_response: {
      optional: true,
      verdict: "read",
      reason: "Reads the current Operator chat response without starting work.",
    },
    get_proposal_details: {
      optional: true,
      verdict: "read",
      reason: "Reads pending proposals and their before/after content without applying them.",
    },
    apply_proposals: {
      optional: true,
      verdict: "destructive",
      reason: "Creates, overwrites, publishes or deletes live workspace configuration; some changes cannot be undone.",
    },
    reject_proposals: {
      optional: true,
      verdict: "destructive",
      reason:
        "Discards pending proposals. Conservatively treats deletion of proposal state as destructive despite Intercom's non-destructive hint.",
    },
  },
};

const OPTIONS = optionsOf<IntercomOptions>()({
  ...PROVIDER_COMMON,
  ...keys("region"),
  auth: REMOTE_MCP_AUTH,
});

/** A maintained Intercom hosted-MCP connection for a single workspace region. */
export const intercom = defineProvider<IntercomOptions>({
  name: "intercom",
  title: "Intercom",
  kind: "mcp",
  readme: "Intercom",
  skill,
  options: OPTIONS,
  classify: CLASSIFICATION,
  bundle: {
    baselineGzip: 170245,
    note: "./providers/intercom initial measured hosted-MCP baseline is 170,245 B gzip; the cap reserves 60,000 B of headroom.",
  },
  create(id, options, provider) {
    if (options.region !== "us" && options.region !== "eu") {
      throw new Error(`intercom("${id}") requires region "us" or "eu" matching the workspace; AU is not supported.`);
    }
    const auth = options.auth ?? { type: "oauth" };
    const authScope = options.authScope ?? (auth.type === "oauth" ? "personal" : "shared");
    return remoteMcp(id, {
      ...provider.connectorOptions,
      url: INTERCOM_MCP_ENDPOINTS[options.region],
      title: options.title ?? `Intercom (${options.region.toUpperCase()})`,
      description: `Intercom conversations, contacts, companies, articles and optional Fin Operator — ${options.purpose}`,
      authScope,
      auth: withCredentialDefaults(auth, {
        credential: {
          label: "Intercom API token",
          description:
            "An Intercom API access token with only the workspace permissions this connection needs. Stored encrypted and sent as Authorization: Bearer. Fin Operator requires OAuth instead.",
          placeholder: "Paste Intercom API token",
        },
      }),
      requireHttps: true,
      classify: provider.classify,
      usageGuide: provider.usageGuide({
        context: [
          `Customer support workspace in ${options.region.toUpperCase()}: ${options.purpose}. Article creation, article updates, internal notes and Operator actions can write.`,
          authScope === "personal"
            ? "Each person authorizes separately; OAuth uses that teammate's workspace permissions and seat rules."
            : "This connector shares one workspace authorization; all callers act through its grant.",
          auth.type === "oauth"
            ? "OAuth discovers the mcp and operator scopes. Fin Operator additionally requires workspace availability and teammate permission."
            : "Bearer API token access: Fin Operator tools are unavailable.",
        ],
        summary: `Intercom ${options.region.toUpperCase()}: sensitive support data, article/note writes and optional Fin Operator.`,
      }),
    });
  },
});
