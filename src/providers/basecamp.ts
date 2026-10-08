import { remoteMcp } from "../connectors/remote-mcp.js";
import { vettedCatalog, withVettedCatalog } from "../catalog-drift.js";
import { defined } from "../connectors/api-connector.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
} from "../types.js";
import { keys, optionsOf } from "../config-schema.js";
import { PROVIDER_COMMON } from "../connectors/option-shapes.js";
import { asProvider } from "../described.js";

/**
 * Basecamp's one hosted MCP endpoint, streamable HTTP.
 *
 * Live but undocumented: as of 2026-10-05 37signals has announced no MCP
 * server, and basecamp.com/agents (where the endpoint's own 401 body points)
 * describes the CLI and SDKs without naming it. What the server does publish is
 * its OAuth discovery — protected-resource metadata naming
 * `https://app.basecamp.com` as the authorization server — and that is what
 * this provider is written against, beside a captured live `tools/list`.
 */
export const BASECAMP_MCP_ENDPOINT = "https://mcp.basecamp.com/mcp";

/**
 * Requested only when Basecamp stops advertising scopes of its own.
 *
 * The MCP client picks the scope from the `WWW-Authenticate` challenge first
 * (`mcp full` today), then the protected resource's `scopes_supported`, and
 * only then this value — appending `offline_access` itself whenever the
 * authorization server lists it. So for Basecamp as it serves today, this is a
 * fallback that matches what the challenge already asks for, not a lever.
 */
const FALLBACK_SCOPE = "full mcp offline_access";

export interface BasecampOptions {
  /** Human-readable display name; defaults to "Basecamp". */
  title?: string;
  /**
   * Downstream auth ownership. Defaults to one shared deployment grant. With
   * `"personal"` each principal authorizes separately and may pick a
   * different Basecamp account at consent, which the guide says.
   */
  authScope?: "shared" | "personal";
  /** Which Basecamp account this is and what decisions it answers. */
  purpose: string;
  /**
   * Required. The HTTPS URL of a Client ID Metadata Document this deployment
   * controls: a public JSON document whose `client_id` is its own URL, whose
   * `redirect_uris` include `<publicUrl>/oauth/callback/<connector id>`, with
   * `token_endpoint_auth_method: "none"` and the `authorization_code` and
   * `refresh_token` grants. Basecamp advertises dynamic client registration
   * but restricts it for HTTPS redirect URIs, which every deployed connecta
   * has; its authorization server accepts a metadata-document client id
   * instead (`client_id_metadata_document_supported: true`). Connecta does not
   * serve one of its own yet, so the deployment hosts it.
   */
  clientMetadataUrl: string;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /**
   * Optional per-runtime policy. There is no default: Basecamp's API documents
   * several dynamically adjusted limits (GET versus POST, per second, hour,
   * and day) and quotes only "currently 50 requests per 10 second period per
   * IP address" for scale — metered at the IP that calls the API, which is
   * Basecamp's own MCP server rather than this runtime. A per-runtime counter
   * approximates none of that, so the operator picks (P12).
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/**
 * Reviewed reads, listed by name (P5), from the live `tools/list` captured
 * 2026-10-05 (227 tools, every one explicitly annotated by the server). Each
 * read below carries the server's own `readOnlyHint: true`; the
 * classification agrees rather than argues. A superset by design: tools gated
 * by account type or feature cost nothing when absent, while an unlisted new
 * one fails closed.
 */
const READ_ONLY_TOOLS = new Set([
  // Orientation and identity
  "get_basecamp_guide",
  "get_me",
  "get_account",
  "get_my_profile",
  "get_my_preferences",
  "get_by_url",
  "search",
  "search_mentions",
  // People
  "get_person",
  "list_people",
  "list_pingable_people",
  "list_assignable_people",
  "list_project_people",
  "get_out_of_office",
  // Projects, docks, and templates
  "list_projects",
  "get_project",
  "get_project_tools",
  "get_dock_tool",
  "get_project_construction",
  "list_templates",
  "get_template",
  "list_folders",
  "get_folder",
  // My work and notifications. Reading the Hey! menu changes nothing; the
  // write that does is `mark_as_read`, below.
  "get_my_assignments",
  "get_my_completed_assignments",
  "get_my_due_assignments",
  "get_my_day",
  "get_catchup",
  "get_my_notifications",
  "get_bubble_ups",
  "get_my_note",
  "list_my_bookmarks",
  "list_my_drafts",
  "get_bookmark",
  "get_question_reminders",
  // Answers the same question as the reads above and renders it in a panel
  // for clients that draw one; connecta relays the data and draws nothing.
  "show_my_work",
  // Activity and feeds. Both feed cursors are held by the caller and passed
  // back, so polling advances nothing on Basecamp's side.
  "get_progress_report",
  "get_project_timeline",
  "get_person_progress",
  "list_feed_events",
  "get_event_inbox",
  "list_everything_feed",
  "list_everything_todos",
  "list_everything_cards",
  "summarize_recording",
  // Mints a short-lived, single-connection WebSocket ticket for the event
  // feed's live lane, and the server files it read-only. Reviewed rather than
  // copied: it writes no Basecamp record, and what the ticket unlocks is a
  // read of the same feed `list_feed_events` already serves on this path.
  // Filing it destructive would be the only lever that overrides the server
  // (an additive verdict cannot), and it would buy a standing annotation
  // conflict on every refresh for a tool connecta's one-request calls cannot
  // use anyway — so the guide tells agents not to call it instead.
  "create_stream_ticket",
  // To-dos
  "get_todoset",
  "list_todolists",
  "get_todolist",
  "list_todolist_groups",
  "get_todolist_group",
  "list_todos",
  "get_todo",
  "get_assigned_todos",
  "get_overdue_todos",
  "get_hill_chart",
  // Messages
  "get_message_board",
  "list_messages",
  "get_message",
  "list_message_types",
  "get_message_type",
  // Comments and boosts
  "list_comments",
  "get_comment",
  "list_recording_boosts",
  "list_event_boosts",
  "get_boost",
  // Card tables
  "get_card_table",
  "get_card_column",
  "list_cards",
  "get_card",
  "get_card_step",
  // Chat
  "get_campfire",
  "list_campfire_lines",
  "get_campfire_line",
  "list_campfire_uploads",
  // Schedules
  "get_schedule",
  "list_schedule_entries",
  "get_schedule_entry",
  "get_schedule_entry_occurrence",
  "get_upcoming_schedule",
  "get_calendar",
  "list_lineup_markers",
  // Docs and files
  "get_vault",
  "list_vaults",
  "list_documents",
  "get_document",
  "list_uploads",
  "get_upload",
  "list_upload_versions",
  "get_cloud_file",
  "get_google_document",
  // Check-ins
  "get_questionnaire",
  "list_questions",
  "get_question",
  "list_question_answerers",
  "list_answers",
  "get_answer",
  "get_answers_by_person",
  // Timesheets
  "get_timesheet_report",
  "get_project_timesheet",
  "get_recording_timesheet",
  "get_timesheet_entry",
  // Gauges
  "list_gauges",
  "list_gauge_needles",
  "get_gauge_needle",
]);

/**
 * Reviewed writes with their destructive verdict. Most follow the server's
 * own explicit annotation, which is also what the verb says: `create_*` brings
 * a record into being, and `update_*`, `trash_*`, `delete_*`, `destroy_*`,
 * moves, repositions, and toggles act on one that exists. The four rows that
 * part from the server carry their reason.
 *
 * Trash and permanent deletion are both destructive, because both take a
 * record out of everyone's view; the difference — `trash_*` is restorable for
 * 25 days, `delete_*`/`destroy_*` and `remove_account_logo` are not — is the
 * guide's to say, not a third verdict's.
 */
const WRITE_TOOLS: ReadonlyMap<string, "additive" | "destructive"> = new Map([
  // Account and profile
  ["update_account_name", "destructive"],
  ["remove_account_logo", "destructive"],
  ["update_my_profile", "destructive"],
  ["update_my_preferences", "destructive"],
  // "The first update creates the note", but every later one replaces it.
  ["update_my_note", "destructive"],
  ["enable_out_of_office", "destructive"],
  ["disable_out_of_office", "destructive"],
  // Projects, docks, and templates
  ["create_project", "additive"],
  ["create_project_from_template", "additive"],
  ["update_project", "destructive"],
  // Grants and revokes access, and can create people — that is, invite an
  // outside address into the account (the server marks it open-world).
  ["update_project_access", "destructive"],
  ["trash_project", "destructive"],
  ["create_template", "additive"],
  ["update_template", "destructive"],
  ["delete_template", "destructive"],
  ["enable_dock_tool", "destructive"],
  ["disable_dock_tool", "destructive"],
  ["update_dock_tool", "destructive"],
  ["reposition_dock_tool", "destructive"],
  ["trash_dock_tool", "destructive"],
  // Destructive where the server says additive: "optionally filing projects
  // into it" moves projects that already sit on the person's home screen, so
  // the call can rearrange existing state as well as create a folder.
  ["create_folder", "destructive"],
  ["update_folder", "destructive"],
  ["delete_folder", "destructive"],
  // My work. Prioritizing adds an assignment to the person's own list and
  // removes nothing — RevenueCat's attach/detach argument — so it is additive
  // where the server says destructive; deprioritizing and reordering are the
  // halves that move existing state. The server's explicit `destructiveHint`
  // still stands at runtime: the classification fills silence and does not
  // soften an annotation, so this verdict is the release's record, not an
  // overrule.
  ["prioritize_assignment", "additive"],
  ["deprioritize_assignment", "destructive"],
  ["reorder_up_next", "destructive"],
  // Flips the read state of existing notifications, which is how a person
  // knows what they have not seen yet — and no tool flips it back.
  ["mark_as_read", "destructive"],
  ["create_bookmark", "additive"],
  ["delete_bookmark", "destructive"],
  // To-dos
  ["create_todolist", "additive"],
  ["update_todolist", "destructive"],
  ["reposition_todolist", "destructive"],
  ["trash_todolist", "destructive"],
  ["create_todolist_group", "additive"],
  ["update_todolist_group", "destructive"],
  ["reposition_todolist_group", "destructive"],
  ["trash_todolist_group", "destructive"],
  ["create_todo", "additive"],
  ["create_todoset_todo", "additive"],
  ["update_todo", "destructive"],
  ["complete_todo", "destructive"],
  ["uncomplete_todo", "destructive"],
  ["reposition_todo", "destructive"],
  ["trash_todo", "destructive"],
  ["update_hill_chart_settings", "destructive"],
  // Messages
  ["create_message", "additive"],
  ["update_message", "destructive"],
  ["pin_message", "destructive"],
  ["unpin_message", "destructive"],
  ["archive_message", "destructive"],
  ["unarchive_message", "destructive"],
  ["trash_message", "destructive"],
  ["create_message_type", "additive"],
  ["update_message_type", "destructive"],
  ["delete_message_type", "destructive"],
  // Comments and boosts
  ["create_comment", "additive"],
  ["update_comment", "destructive"],
  ["trash_comment", "destructive"],
  ["create_recording_boost", "additive"],
  ["create_event_boost", "additive"],
  ["delete_boost", "destructive"],
  // Card tables
  ["create_card_column", "additive"],
  ["update_card_column", "destructive"],
  ["move_card_column", "destructive"],
  ["set_card_column_color", "destructive"],
  ["enable_card_column_on_hold", "destructive"],
  ["disable_card_column_on_hold", "destructive"],
  // Watching a column adds the person to its subscribers and removes nothing:
  // additive for the same reason as `prioritize_assignment`, with the server's
  // explicit `destructiveHint` still the one a caller sees. Two endpoints, one
  // effect, so both names get the same verdict; the unwatching halves stay
  // destructive.
  ["watch_column", "additive"],
  ["subscribe_to_card_column", "additive"],
  ["unwatch_column", "destructive"],
  ["unsubscribe_from_card_column", "destructive"],
  ["create_wormhole", "additive"],
  ["update_wormhole", "destructive"],
  ["delete_wormhole", "destructive"],
  ["create_card", "additive"],
  ["update_card", "destructive"],
  ["move_card", "destructive"],
  ["trash_card", "destructive"],
  ["create_card_step", "additive"],
  ["update_card_step", "destructive"],
  ["complete_card_step", "destructive"],
  ["uncomplete_card_step", "destructive"],
  ["reposition_card_step", "destructive"],
  ["delete_card_step", "destructive"],
  // Chat
  ["create_campfire_line", "additive"],
  ["create_campfire_upload", "additive"],
  ["delete_campfire_line", "destructive"],
  // Schedules
  ["create_schedule_entry", "additive"],
  ["update_schedule_entry", "destructive"],
  ["trash_schedule_entry", "destructive"],
  ["update_schedule_settings", "destructive"],
  ["update_calendar", "destructive"],
  ["create_lineup_marker", "additive"],
  ["update_lineup_marker", "destructive"],
  ["delete_lineup_marker", "destructive"],
  // Docs and files. `create_attachment` uploads bytes and returns the
  // `attachable_sgid` that `create_upload` files into a vault.
  ["create_vault", "additive"],
  ["update_vault", "destructive"],
  ["create_document", "additive"],
  ["update_document", "destructive"],
  ["trash_document", "destructive"],
  ["create_attachment", "additive"],
  ["create_upload", "additive"],
  ["update_upload", "destructive"],
  ["trash_upload", "destructive"],
  ["create_cloud_file", "additive"],
  ["update_cloud_file", "destructive"],
  ["create_google_document", "additive"],
  ["update_google_document", "destructive"],
  // Check-ins
  ["create_question", "additive"],
  ["update_question", "destructive"],
  ["pause_question", "destructive"],
  ["resume_question", "destructive"],
  ["update_question_notification_settings", "destructive"],
  ["create_answer", "additive"],
  ["update_answer", "destructive"],
  // Timesheets
  ["create_timesheet_entry", "additive"],
  ["update_timesheet_entry", "destructive"],
  ["destroy_timesheet_entry", "destructive"],
  // Gauges
  ["toggle_gauge", "destructive"],
  ["create_gauge_needle", "additive"],
  ["update_gauge_needle", "destructive"],
  ["destroy_gauge_needle", "destructive"],
]);

/**
 * One release-reviewed manifest, used both to classify a live tool and as the
 * baseline the runtime drift check compares against, so the annotation a
 * caller gets and the verdict a check reads can never disagree (P13). Names
 * and verdicts only — no schemas are vendored; the live `tools/list` response
 * stays authoritative.
 *
 * Basecamp publishes no tool inventory, so this list has no public document
 * to be checked against before a release. Catalog drift is visible at runtime
 * only — as unclassified-tool and unserved-name counts on connector status and
 * `/health` — and the credential-free provider check reads the OAuth
 * discovery metadata the server does publish instead.
 */
export const BASECAMP_VETTED_CATALOG = vettedCatalog({
  reads: READ_ONLY_TOOLS,
  writes: WRITE_TOOLS,
});

/** The catalog's summary bound; a longer declared value throws (`src/registry.ts`). */
const SUMMARY_BUDGET = 120;

/**
 * Fit a purpose-bearing summary inside the catalog's bound. Basecamp's routing
 * fact is the account a grant reached, which only the operator's purpose can
 * name, so the summary carries the purpose and clipping is this function's
 * job rather than the operator's.
 */
function boundedSummary(prefix: string, purpose: string): string {
  const full = `${prefix}${purpose}`;
  if (full.length <= SUMMARY_BUDGET) return full;
  return `${full.slice(0, SUMMARY_BUDGET - 1).trimEnd()}…`;
}

function usageGuide(
  purpose: string,
  authScope: "shared" | "personal",
  instructions: string | undefined,
): string {
  const accountInstructions = instructions?.trim();
  // Leads the guide because discovery summarizes a connector by its first
  // content line, and which account a call lands in is the one thing that
  // decides routing between two Basecamp connections (P3).
  const grant =
    authScope === "personal"
      ? "Each person authorizes this connector separately and picks the account on Basecamp's consent screen, so two people can reach different accounts through it."
      : "One shared authorization, made on Basecamp's consent screen, decides that account for everyone who uses this connector.";
  return `# Basecamp usage

One account per authorization: ${purpose}. Basecamp's hosted server acts in the single account the grant was made for, and no tool takes an account id. ${grant} Another account is another connector, never an argument.

- Confirm the account before relying on it: \`get_me\` returns the signed-in person and a label naming the connected account. A record id from another account's URL answers "not found" here — read that as wrong connector, not missing data.
- Basecamp's own reference notes are a read away: \`get_basecamp_guide\` with \`topic\` \`concepts\`, \`finding-things\`, \`my-work\`, \`posting-and-mentions\`, or \`deleting-and-trash\`. Read the topic before an unfamiliar sequence instead of guessing one.
- Resolve ids before acting; never guess one. A Basecamp URL carries the account, project, and record ids, and \`get_by_url\` reads any link into those ids, the record, and where a reply goes. \`search\` finds records by text; \`list_projects\` then \`get_project\` returns a project's dock, whose tool ids (to-do set, message board, schedule, vault, card table, chat) the create tools take. People are ids from \`list_people\`, \`list_project_people\`, or \`list_pingable_people\`; mention someone by passing ids as \`create_comment\`'s \`mentions\`, not by writing markup.
- Rich-text bodies (messages, documents, comments, cards, to-do descriptions) are HTML; a to-do's title and a chat line are plain text. Dates are \`YYYY-MM-DD\`.
- Lists return up to \`limit\` items (100 by default). Continue with the \`next_cursor\` or \`next_page\` a result carries rather than raising the limit; \`truncated: true\` means the server cut a result to fit and says where to resume. The event feeds page by \`position\` instead. \`get_card_table\`, \`get_document\`, and the account-wide \`list_everything_*\` reads are large — reduce inside \`execute_code\` and return only the fields the question needs.
- \`trash_*\` is restorable for 25 days; \`delete_*\`, \`destroy_*\`, and \`remove_account_logo\` are permanent. \`update_cloud_file\` and \`update_google_document\` are full replaces: an omitted title or description is erased, so read the record and resend every field you keep. \`update_project_access\` can invite people into the account.
- Do not call \`create_stream_ticket\`: it mints a WebSocket credential for a client that holds a live connection, which a connecta call cannot. Poll \`list_feed_events\` instead. \`get_event_inbox\` serves agent accounts only; a person's grant gets \`agents_only\` back.
- This connector's tool list is not a fixed set. Basecamp has not published this server and changes it without notice, and timesheets, gauges, hill charts, the Lineup, and check-ins depend on account features, so search this connector for what it actually exposes rather than assuming a tool exists.
- Basecamp answers a rate limit with \`429\` and a \`Retry-After\` in seconds, and adjusts its limits dynamically. Back off for that long rather than retrying at once, and avoid speculative fan-out.
- Treat every create, update, trash, delete, destroy, move, reposition, complete, pin, archive, enable, disable, watch, and mark operation as a write. Connecta routes the maintained write catalog through \`call_destructive_tool\`; newly added tools also fail closed until a release classifies them.
- An \`auth_required\` failure means this connector's Basecamp authorization is missing or expired: run \`authorize_connector\` for this connector id, then retry the same call unchanged. A rejected argument, a permission gap, or a missing feature comes back in Basecamp's own words instead — read it rather than re-authorizing.
${
    accountInstructions
      ? `\n## Account instructions\n\n${accountInstructions}\n`
      : ""
  }`;
}


/** The closed options basecamp() accepts; see `assertKnownOptions`. */
const BASECAMP_OPTIONS = optionsOf<BasecampOptions>()({ ...PROVIDER_COMMON, ...keys("clientMetadataUrl") });

/** A maintained Basecamp hosted-MCP connection. */
export function basecamp(id: string, options: BasecampOptions): Connector {
  return asProvider("basecamp", BASECAMP_OPTIONS, id, options, basecampConnector);
}

function basecampConnector(id: string, options: BasecampOptions): Connector {
  const purpose = options.purpose.trim();
  if (!purpose) {
    throw new Error("basecamp() requires a non-empty account purpose.");
  }
  const clientMetadataUrl = options.clientMetadataUrl;
  if (typeof clientMetadataUrl !== "string" || !clientMetadataUrl.trim()) {
    // A structural mistake, so it throws here rather than at the first
    // authorization, where the failure would be Basecamp refusing a
    // registration nobody in the conversation can repair.
    throw new Error(
      `basecamp("${id}") requires clientMetadataUrl: Basecamp restricts dynamic client registration for HTTPS redirect URIs, so connecta must present a Client ID Metadata Document instead. Host a public HTTPS JSON document whose client_id is its own URL and whose redirect_uris include <publicUrl>/oauth/callback/${id}.`,
    );
  }
  const authScope = options.authScope ?? "shared";
  const connector = remoteMcp(id, {
    url: BASECAMP_MCP_ENDPOINT,
    ...(options.authScope ? { authScope: options.authScope } : {}),
    title: options.title ?? "Basecamp",
    description: `Basecamp projects, to-dos, messages, cards, schedules, and files (one account per authorization) — ${purpose}`,
    // OAuth only (P9's headless alternative knowingly missed). Basecamp issues
    // personal access tokens at app.basecamp.com/my/access_tokens, but nothing
    // public says this endpoint accepts one, and a PAT carries no refresh
    // token; shipping a slot for a framing nobody has verified is the
    // borrowed-convention mistake P9 names. The access mode P4 asks for is
    // missing for the same kind of reason: Basecamp advertises a `read` scope
    // beside `full`, but the MCP client requests the scope the server's own
    // challenge names (`mcp full`) ahead of anything configured here, and what
    // `read` permits on this server is unverified — a read-only option would
    // be a label, not a guarantee. The classification fails closed either way.
    auth: {
      type: "oauth",
      clientMetadataUrl,
      scope: FALLBACK_SCOPE,
    },
    requireHttps: true,
    usageGuide: {
      content: usageGuide(purpose, authScope, options.instructions),
      // Explicit rather than derived, and purpose-bearing: the derived summary
      // would cut the account sentence mid-clause, and two Basecamp
      // connections differ only by the account each grant reached (P3).
      summary: boundedSummary("One account per grant; get_me names it: ", purpose),
      // Not `required`. Basecamp's own schemas and `get_basecamp_guide` cover
      // each call; this guide carries account routing and the id chain, worth
      // reading before a run rather than before every call.
    },
    ...defined({
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
  });
  return withVettedCatalog(connector, BASECAMP_VETTED_CATALOG);
}
