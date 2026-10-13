import { remoteMcp, type RemoteMcpAuth } from "../../connectors/remote-mcp.js";
import { keys, optionsOf, variants } from "../../config-schema.js";
import { defineProvider, PROVIDER_COMMON, type ProviderOptions } from "../../provider.js";
import type { ToolClassification } from "../../types.js";
import { skill } from "./skill.generated.js";

/** Wispr Flow's hosted Streamable HTTP endpoint, without a trailing slash. */
export const WISPR_FLOW_MCP_ENDPOINT = "https://api.wisprflow.ai/connect/mcp";

type WisprFlowOAuth = Extract<RemoteMcpAuth, { type: "oauth" }>;

export interface WisprFlowOptions extends ProviderOptions {
  /** OAuth only; defaults to browser authorization with the advertised scopes. */
  auth?: WisprFlowOAuth;
}

/**
 * Reviewed public-source superset, 2026-10-13. Scalekit documents 14 reads;
 * Claude's connector directory adds four task tools. Wispr's own help page
 * describes read-only access, so the task writes remain classified even if
 * this account never exposes them. No authenticated catalog or schemas were
 * captured. Vendor names, schemas and results remain live.
 */
const CLASSIFICATION: ToolClassification = {
  tools: {
    get_account_info: { verdict: "read", reason: "Returns the signed-in identity and calendar display-name aliases." },
    get_calendar_event: { verdict: "read", reason: "Retrieves an existing calendar event and its attendees." },
    get_meeting: {
      verdict: "read",
      reason: "Retrieves recorded notes, the summary, attendees and requested transcript ranges.",
    },
    get_meeting_by_calendar_id: {
      verdict: "read",
      reason: "Finds the existing recording linked to a calendar event and reads its content.",
    },
    get_meeting_participants_enriched: {
      verdict: "read",
      reason: "Reads participant information and identifies the signed-in attendee.",
    },
    get_scratchpad_note: { verdict: "read", reason: "Returns a bounded range of an existing Scratchpad note." },
    get_upcoming_meeting: {
      verdict: "read",
      reason: "Reads an upcoming event and an available pre-read without generating one.",
    },
    list_meeting_series: {
      verdict: "read",
      reason: "Lists recorded occurrences of an existing recurring meeting series.",
    },
    list_upcoming_meetings: {
      verdict: "read",
      reason: "Lists upcoming calendar events and already-available pre-reads.",
    },
    resolve_calendar_link: {
      verdict: "read",
      reason: "Matches a pasted calendar or conference URL to an existing event.",
    },
    resolve_share_link: {
      verdict: "read",
      reason: "Reads an accessible shared note without creating a link or changing sharing permissions.",
    },
    search_calendar_events: { verdict: "read", reason: "Finds existing calendar events by date, attendees or text." },
    search_meetings: {
      verdict: "read",
      reason: "Finds recorded meetings by title, summary, notes, dates or linked attendees.",
    },
    search_scratchpad_notes: { verdict: "read", reason: "Finds existing Scratchpad notes by text." },
    get_task: { verdict: "read", reason: "Retrieves an existing task without changing its state." },
    search_tasks: { verdict: "read", reason: "Finds existing tasks without changing them." },
    add_task: {
      verdict: "write",
      reason: "Creates a new task; the reviewed operation appends rather than replacing an existing task.",
    },
    update_task: { verdict: "destructive", reason: "Changes the state or fields of an existing task." },
  },
};

const OPTIONS = optionsOf<WisprFlowOptions>()({
  ...PROVIDER_COMMON,
  auth: variants("type", {
    oauth: optionsOf<WisprFlowOAuth>()({
      ...keys("type", "clientMetadataUrl", "scope"),
      client: optionsOf<NonNullable<WisprFlowOAuth["client"]>>()(
        keys("issuer", "clientId", "clientSecret", "tokenEndpointAuthMethod"),
      ),
    }).shape,
  }),
});

/** A maintained Wispr Flow Notetaker hosted-MCP connection. */
export const wisprFlow = defineProvider<WisprFlowOptions>({
  name: "wispr-flow",
  title: "Wispr Flow",
  kind: "mcp",
  readme: "Wispr Flow",
  skill,
  classify: CLASSIFICATION,
  options: OPTIONS,
  bundle: {
    baselineGzip: 169009,
    maxGzip: 229009,
    note: "./providers/wispr-flow initial measured baseline is 169,009 B gzip for the hosted-MCP wrapper; the cap retains the existing baseline + 60,000 B provider headroom policy.",
  },
  create(id, options, provider) {
    const ownership =
      options.authScope === "personal"
        ? "Each person authorizes separately and may reach a different account."
        : "One shared authorization selects the account for everyone using this connector.";
    return remoteMcp(id, {
      url: WISPR_FLOW_MCP_ENDPOINT,
      ...provider.connectorOptions,
      title: options.title ?? "Wispr Flow",
      description: `Wispr Flow Notetaker meetings, Scratchpad notes, calendar events and tasks: ${options.purpose}`,
      auth: { type: "oauth", scope: "openid offline_access", ...options.auth },
      requireHttps: true,
      classify: provider.classify,
      usageGuide: provider.usageGuide({
        context: [
          `Account-wide Notetaker access. Personal and work accounts hold separate content. ${ownership} Confirm the identity with get_account_info. Dictation history and Notetaker chat history are unavailable.`,
          `Account purpose: ${options.purpose}`,
        ],
        summary:
          "Account-wide Notetaker access. Resolve ids, page notes and transcripts; task creates and updates are writes.",
      }),
    });
  },
});
