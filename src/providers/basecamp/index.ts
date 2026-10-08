import { skill } from "./skill.generated.js";
import { remoteMcp } from "../../connectors/remote-mcp.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import type {
  Connector,
  ToolClassification,
  ConnectorCallAdmissionPolicy,
} from "../../types.js";
import { keys, optionsOf } from "../../config-schema.js";
import { PROVIDER_COMMON } from "../../connectors/option-shapes.js";
import { defineProvider, type ProviderContext } from "../../provider.js";

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
 * Retains the 227-tool live tools/list review captured on 2026-10-05,
 * including the server's explicit read annotations. Basecamp publishes no
 * inventory; credential-free checks can only verify OAuth discovery.
 * Reviewed in #705's provider audit against https://mcp.basecamp.com/.well-known/oauth-protected-resource/mcp.
 * Retains the release-reviewed inventory, including names absent from today's
 * public reference. Live annotations were not reverified without credentials.
 * No schema digest is asserted without a captured schema to review.
 */
const BASECAMP_CLASSIFICATION: ToolClassification = {
  tools: {
    "get_basecamp_guide": {"verdict": "read", "reason": "Reads Basecamp reference guidance; it does not change account state."},
    "get_me": {"verdict": "read", "reason": "Reads the signed-in identity and connected account label."},
    "get_account": {"verdict": "read", "reason": "Retrieves Basecamp account information without changing vendor state."},
    "get_my_profile": {"verdict": "read", "reason": "Retrieves Basecamp my profile information without changing vendor state."},
    "get_my_preferences": {"verdict": "read", "reason": "Retrieves Basecamp my preferences information without changing vendor state."},
    "get_by_url": {"verdict": "read", "reason": "Resolves a Basecamp URL and reads its record; it does not change the target."},
    "search": {"verdict": "read", "reason": "Searches Basecamp records without modifying them."},
    "search_mentions": {"verdict": "read", "reason": "Retrieves Basecamp mentions information without changing vendor state."},
    "get_person": {"verdict": "read", "reason": "Retrieves Basecamp person information without changing vendor state."},
    "list_people": {"verdict": "read", "reason": "Retrieves Basecamp people information without changing vendor state."},
    "list_pingable_people": {"verdict": "read", "reason": "Retrieves Basecamp pingable people information without changing vendor state."},
    "list_assignable_people": {"verdict": "read", "reason": "Retrieves Basecamp assignable people information without changing vendor state."},
    "list_project_people": {"verdict": "read", "reason": "Retrieves Basecamp project people information without changing vendor state."},
    "get_out_of_office": {"verdict": "read", "reason": "Retrieves Basecamp out of office information without changing vendor state."},
    "list_projects": {"verdict": "read", "reason": "Retrieves Basecamp projects information without changing vendor state."},
    "get_project": {"verdict": "read", "reason": "Retrieves Basecamp project information without changing vendor state."},
    "get_project_tools": {"verdict": "read", "reason": "Retrieves Basecamp project tools information without changing vendor state."},
    "get_dock_tool": {"verdict": "read", "reason": "Retrieves Basecamp dock tool information without changing vendor state."},
    "get_project_construction": {"verdict": "read", "reason": "Retrieves Basecamp project construction information without changing vendor state."},
    "list_templates": {"verdict": "read", "reason": "Retrieves Basecamp templates information without changing vendor state."},
    "get_template": {"verdict": "read", "reason": "Retrieves Basecamp template information without changing vendor state."},
    "list_folders": {"verdict": "read", "reason": "Retrieves Basecamp folders information without changing vendor state."},
    "get_folder": {"verdict": "read", "reason": "Retrieves Basecamp folder information without changing vendor state."},
    "get_my_assignments": {"verdict": "read", "reason": "Retrieves Basecamp my assignments information without changing vendor state."},
    "get_my_completed_assignments": {"verdict": "read", "reason": "Retrieves Basecamp my completed assignments information without changing vendor state."},
    "get_my_due_assignments": {"verdict": "read", "reason": "Retrieves Basecamp my due assignments information without changing vendor state."},
    "get_my_day": {"verdict": "read", "reason": "Retrieves Basecamp my day information without changing vendor state."},
    "get_catchup": {"verdict": "read", "reason": "Retrieves Basecamp catchup information without changing vendor state."},
    "get_my_notifications": {"verdict": "read", "reason": "Retrieves Basecamp my notifications information without changing vendor state."},
    "get_bubble_ups": {"verdict": "read", "reason": "Retrieves Basecamp bubble ups information without changing vendor state."},
    "get_my_note": {"verdict": "read", "reason": "Retrieves Basecamp my note information without changing vendor state."},
    "list_my_bookmarks": {"verdict": "read", "reason": "Retrieves Basecamp my bookmarks information without changing vendor state."},
    "list_my_drafts": {"verdict": "read", "reason": "Retrieves Basecamp my drafts information without changing vendor state."},
    "get_bookmark": {"verdict": "read", "reason": "Retrieves Basecamp bookmark information without changing vendor state."},
    "get_question_reminders": {"verdict": "read", "reason": "Retrieves Basecamp question reminders information without changing vendor state."},
    "show_my_work": {"verdict": "read", "reason": "Retrieves Basecamp my work information without changing vendor state."},
    "get_progress_report": {"verdict": "read", "reason": "Retrieves Basecamp progress report information without changing vendor state."},
    "get_project_timeline": {"verdict": "read", "reason": "Retrieves Basecamp project timeline information without changing vendor state."},
    "get_person_progress": {"verdict": "read", "reason": "Retrieves Basecamp person progress information without changing vendor state."},
    "list_feed_events": {"verdict": "read", "reason": "Retrieves Basecamp feed events information without changing vendor state."},
    "get_event_inbox": {"verdict": "read", "reason": "Retrieves Basecamp event inbox information without changing vendor state."},
    "list_everything_feed": {"verdict": "read", "reason": "Retrieves Basecamp everything feed information without changing vendor state."},
    "list_everything_todos": {"verdict": "read", "reason": "Retrieves Basecamp everything todos information without changing vendor state."},
    "list_everything_cards": {"verdict": "read", "reason": "Retrieves Basecamp everything cards information without changing vendor state."},
    "summarize_recording": {"verdict": "read", "reason": "Retrieves Basecamp recording information without changing vendor state."},
    "create_stream_ticket": {"verdict": "read", "reason": "Mints a WebSocket credential, which is a side effect even without a persistent record."},
    "get_todoset": {"verdict": "read", "reason": "Retrieves Basecamp todoset information without changing vendor state."},
    "list_todolists": {"verdict": "read", "reason": "Retrieves Basecamp todolists information without changing vendor state."},
    "get_todolist": {"verdict": "read", "reason": "Retrieves Basecamp todolist information without changing vendor state."},
    "list_todolist_groups": {"verdict": "read", "reason": "Retrieves Basecamp todolist groups information without changing vendor state."},
    "get_todolist_group": {"verdict": "read", "reason": "Retrieves Basecamp todolist group information without changing vendor state."},
    "list_todos": {"verdict": "read", "reason": "Retrieves Basecamp todos information without changing vendor state."},
    "get_todo": {"verdict": "read", "reason": "Retrieves Basecamp todo information without changing vendor state."},
    "get_assigned_todos": {"verdict": "read", "reason": "Retrieves Basecamp assigned todos information without changing vendor state."},
    "get_overdue_todos": {"verdict": "read", "reason": "Retrieves Basecamp overdue todos information without changing vendor state."},
    "get_hill_chart": {"verdict": "read", "reason": "Retrieves Basecamp hill chart information without changing vendor state."},
    "get_message_board": {"verdict": "read", "reason": "Retrieves Basecamp message board information without changing vendor state."},
    "list_messages": {"verdict": "read", "reason": "Retrieves Basecamp messages information without changing vendor state."},
    "get_message": {"verdict": "read", "reason": "Retrieves Basecamp message information without changing vendor state."},
    "list_message_types": {"verdict": "read", "reason": "Retrieves Basecamp message types information without changing vendor state."},
    "get_message_type": {"verdict": "read", "reason": "Retrieves Basecamp message type information without changing vendor state."},
    "list_comments": {"verdict": "read", "reason": "Retrieves Basecamp comments information without changing vendor state."},
    "get_comment": {"verdict": "read", "reason": "Retrieves Basecamp comment information without changing vendor state."},
    "list_recording_boosts": {"verdict": "read", "reason": "Retrieves Basecamp recording boosts information without changing vendor state."},
    "list_event_boosts": {"verdict": "read", "reason": "Retrieves Basecamp event boosts information without changing vendor state."},
    "get_boost": {"verdict": "read", "reason": "Retrieves Basecamp boost information without changing vendor state."},
    "get_card_table": {"verdict": "read", "reason": "Retrieves Basecamp card table information without changing vendor state."},
    "get_card_column": {"verdict": "read", "reason": "Retrieves Basecamp card column information without changing vendor state."},
    "list_cards": {"verdict": "read", "reason": "Retrieves Basecamp cards information without changing vendor state."},
    "get_card": {"verdict": "read", "reason": "Retrieves Basecamp card information without changing vendor state."},
    "get_card_step": {"verdict": "read", "reason": "Retrieves Basecamp card step information without changing vendor state."},
    "get_campfire": {"verdict": "read", "reason": "Retrieves Basecamp campfire information without changing vendor state."},
    "list_campfire_lines": {"verdict": "read", "reason": "Retrieves Basecamp campfire lines information without changing vendor state."},
    "get_campfire_line": {"verdict": "read", "reason": "Retrieves Basecamp campfire line information without changing vendor state."},
    "list_campfire_uploads": {"verdict": "read", "reason": "Retrieves Basecamp campfire uploads information without changing vendor state."},
    "get_schedule": {"verdict": "read", "reason": "Retrieves Basecamp schedule information without changing vendor state."},
    "list_schedule_entries": {"verdict": "read", "reason": "Retrieves Basecamp schedule entries information without changing vendor state."},
    "get_schedule_entry": {"verdict": "read", "reason": "Retrieves Basecamp schedule entry information without changing vendor state."},
    "get_schedule_entry_occurrence": {"verdict": "read", "reason": "Retrieves Basecamp schedule entry occurrence information without changing vendor state."},
    "get_upcoming_schedule": {"verdict": "read", "reason": "Retrieves Basecamp upcoming schedule information without changing vendor state."},
    "get_calendar": {"verdict": "read", "reason": "Retrieves Basecamp calendar information without changing vendor state."},
    "list_lineup_markers": {"verdict": "read", "reason": "Retrieves Basecamp lineup markers information without changing vendor state."},
    "get_vault": {"verdict": "read", "reason": "Retrieves Basecamp vault information without changing vendor state."},
    "list_vaults": {"verdict": "read", "reason": "Retrieves Basecamp vaults information without changing vendor state."},
    "list_documents": {"verdict": "read", "reason": "Retrieves Basecamp documents information without changing vendor state."},
    "get_document": {"verdict": "read", "reason": "Retrieves Basecamp document information without changing vendor state."},
    "list_uploads": {"verdict": "read", "reason": "Retrieves Basecamp uploads information without changing vendor state."},
    "get_upload": {"verdict": "read", "reason": "Retrieves Basecamp upload information without changing vendor state."},
    "list_upload_versions": {"verdict": "read", "reason": "Retrieves Basecamp upload versions information without changing vendor state."},
    "get_cloud_file": {"verdict": "read", "reason": "Retrieves Basecamp cloud file information without changing vendor state."},
    "get_google_document": {"verdict": "read", "reason": "Retrieves Basecamp google document information without changing vendor state."},
    "get_questionnaire": {"verdict": "read", "reason": "Retrieves Basecamp questionnaire information without changing vendor state."},
    "list_questions": {"verdict": "read", "reason": "Retrieves Basecamp questions information without changing vendor state."},
    "get_question": {"verdict": "read", "reason": "Retrieves Basecamp question information without changing vendor state."},
    "list_question_answerers": {"verdict": "read", "reason": "Retrieves Basecamp question answerers information without changing vendor state."},
    "list_answers": {"verdict": "read", "reason": "Retrieves Basecamp answers information without changing vendor state."},
    "get_answer": {"verdict": "read", "reason": "Retrieves Basecamp answer information without changing vendor state."},
    "get_answers_by_person": {"verdict": "read", "reason": "Retrieves Basecamp answers by person information without changing vendor state."},
    "get_timesheet_report": {"verdict": "read", "reason": "Retrieves Basecamp timesheet report information without changing vendor state."},
    "get_project_timesheet": {"verdict": "read", "reason": "Retrieves Basecamp project timesheet information without changing vendor state."},
    "get_recording_timesheet": {"verdict": "read", "reason": "Retrieves Basecamp recording timesheet information without changing vendor state."},
    "get_timesheet_entry": {"verdict": "read", "reason": "Retrieves Basecamp timesheet entry information without changing vendor state."},
    "list_gauges": {"verdict": "read", "reason": "Retrieves Basecamp gauges information without changing vendor state."},
    "list_gauge_needles": {"verdict": "read", "reason": "Retrieves Basecamp gauge needles information without changing vendor state."},
    "get_gauge_needle": {"verdict": "read", "reason": "Retrieves Basecamp gauge needle information without changing vendor state."},
    "update_account_name": {"verdict": "destructive", "reason": "update account name changes existing Basecamp state or removes it."},
    "remove_account_logo": {"verdict": "destructive", "reason": "remove account logo changes existing Basecamp state or removes it."},
    "update_my_profile": {"verdict": "destructive", "reason": "update my profile changes existing Basecamp state or removes it."},
    "update_my_preferences": {"verdict": "destructive", "reason": "update my preferences changes existing Basecamp state or removes it."},
    "update_my_note": {"verdict": "destructive", "reason": "update my note changes existing Basecamp state or removes it."},
    "enable_out_of_office": {"verdict": "destructive", "reason": "enable out of office changes existing Basecamp state or removes it."},
    "disable_out_of_office": {"verdict": "destructive", "reason": "disable out of office changes existing Basecamp state or removes it."},
    "create_project": {"verdict": "write", "reason": "create project creates or appends Basecamp state; it has side effects."},
    "create_project_from_template": {"verdict": "write", "reason": "create project from template creates or appends Basecamp state; it has side effects."},
    "update_project": {"verdict": "destructive", "reason": "update project changes existing Basecamp state or removes it."},
    "update_project_access": {"verdict": "destructive", "reason": "update project access changes existing Basecamp state or removes it."},
    "trash_project": {"verdict": "destructive", "reason": "trash project changes existing Basecamp state or removes it."},
    "create_template": {"verdict": "write", "reason": "create template creates or appends Basecamp state; it has side effects."},
    "update_template": {"verdict": "destructive", "reason": "update template changes existing Basecamp state or removes it."},
    "delete_template": {"verdict": "destructive", "reason": "delete template changes existing Basecamp state or removes it."},
    "enable_dock_tool": {"verdict": "destructive", "reason": "enable dock tool changes existing Basecamp state or removes it."},
    "disable_dock_tool": {"verdict": "destructive", "reason": "disable dock tool changes existing Basecamp state or removes it."},
    "update_dock_tool": {"verdict": "destructive", "reason": "update dock tool changes existing Basecamp state or removes it."},
    "reposition_dock_tool": {"verdict": "destructive", "reason": "reposition dock tool changes existing Basecamp state or removes it."},
    "trash_dock_tool": {"verdict": "destructive", "reason": "trash dock tool changes existing Basecamp state or removes it."},
    "create_folder": {"verdict": "destructive", "reason": "create folder changes existing Basecamp state or removes it."},
    "update_folder": {"verdict": "destructive", "reason": "update folder changes existing Basecamp state or removes it."},
    "delete_folder": {"verdict": "destructive", "reason": "delete folder changes existing Basecamp state or removes it."},
    "prioritize_assignment": {"verdict": "write", "reason": "prioritize assignment creates or appends Basecamp state; it has side effects."},
    "deprioritize_assignment": {"verdict": "destructive", "reason": "deprioritize assignment changes existing Basecamp state or removes it."},
    "reorder_up_next": {"verdict": "destructive", "reason": "reorder up next changes existing Basecamp state or removes it."},
    "mark_as_read": {"verdict": "destructive", "reason": "mark as read changes existing Basecamp state or removes it."},
    "create_bookmark": {"verdict": "write", "reason": "create bookmark creates or appends Basecamp state; it has side effects."},
    "delete_bookmark": {"verdict": "destructive", "reason": "delete bookmark changes existing Basecamp state or removes it."},
    "create_todolist": {"verdict": "write", "reason": "create todolist creates or appends Basecamp state; it has side effects."},
    "update_todolist": {"verdict": "destructive", "reason": "update todolist changes existing Basecamp state or removes it."},
    "reposition_todolist": {"verdict": "destructive", "reason": "reposition todolist changes existing Basecamp state or removes it."},
    "trash_todolist": {"verdict": "destructive", "reason": "trash todolist changes existing Basecamp state or removes it."},
    "create_todolist_group": {"verdict": "write", "reason": "create todolist group creates or appends Basecamp state; it has side effects."},
    "update_todolist_group": {"verdict": "destructive", "reason": "update todolist group changes existing Basecamp state or removes it."},
    "reposition_todolist_group": {"verdict": "destructive", "reason": "reposition todolist group changes existing Basecamp state or removes it."},
    "trash_todolist_group": {"verdict": "destructive", "reason": "trash todolist group changes existing Basecamp state or removes it."},
    "create_todo": {"verdict": "write", "reason": "create todo creates or appends Basecamp state; it has side effects."},
    "create_todoset_todo": {"verdict": "write", "reason": "create todoset todo creates or appends Basecamp state; it has side effects."},
    "update_todo": {"verdict": "destructive", "reason": "update todo changes existing Basecamp state or removes it."},
    "complete_todo": {"verdict": "destructive", "reason": "complete todo changes existing Basecamp state or removes it."},
    "uncomplete_todo": {"verdict": "destructive", "reason": "uncomplete todo changes existing Basecamp state or removes it."},
    "reposition_todo": {"verdict": "destructive", "reason": "reposition todo changes existing Basecamp state or removes it."},
    "trash_todo": {"verdict": "destructive", "reason": "trash todo changes existing Basecamp state or removes it."},
    "update_hill_chart_settings": {"verdict": "destructive", "reason": "update hill chart settings changes existing Basecamp state or removes it."},
    "create_message": {"verdict": "write", "reason": "create message creates or appends Basecamp state; it has side effects."},
    "update_message": {"verdict": "destructive", "reason": "update message changes existing Basecamp state or removes it."},
    "pin_message": {"verdict": "destructive", "reason": "pin message changes existing Basecamp state or removes it."},
    "unpin_message": {"verdict": "destructive", "reason": "unpin message changes existing Basecamp state or removes it."},
    "archive_message": {"verdict": "destructive", "reason": "archive message changes existing Basecamp state or removes it."},
    "unarchive_message": {"verdict": "destructive", "reason": "unarchive message changes existing Basecamp state or removes it."},
    "trash_message": {"verdict": "destructive", "reason": "trash message changes existing Basecamp state or removes it."},
    "create_message_type": {"verdict": "write", "reason": "create message type creates or appends Basecamp state; it has side effects."},
    "update_message_type": {"verdict": "destructive", "reason": "update message type changes existing Basecamp state or removes it."},
    "delete_message_type": {"verdict": "destructive", "reason": "delete message type changes existing Basecamp state or removes it."},
    "create_comment": {"verdict": "write", "reason": "create comment creates or appends Basecamp state; it has side effects."},
    "update_comment": {"verdict": "destructive", "reason": "update comment changes existing Basecamp state or removes it."},
    "trash_comment": {"verdict": "destructive", "reason": "trash comment changes existing Basecamp state or removes it."},
    "create_recording_boost": {"verdict": "write", "reason": "create recording boost creates or appends Basecamp state; it has side effects."},
    "create_event_boost": {"verdict": "write", "reason": "create event boost creates or appends Basecamp state; it has side effects."},
    "delete_boost": {"verdict": "destructive", "reason": "delete boost changes existing Basecamp state or removes it."},
    "create_card_column": {"verdict": "write", "reason": "create card column creates or appends Basecamp state; it has side effects."},
    "update_card_column": {"verdict": "destructive", "reason": "update card column changes existing Basecamp state or removes it."},
    "move_card_column": {"verdict": "destructive", "reason": "move card column changes existing Basecamp state or removes it."},
    "set_card_column_color": {"verdict": "destructive", "reason": "set card column color changes existing Basecamp state or removes it."},
    "enable_card_column_on_hold": {"verdict": "destructive", "reason": "enable card column on hold changes existing Basecamp state or removes it."},
    "disable_card_column_on_hold": {"verdict": "destructive", "reason": "disable card column on hold changes existing Basecamp state or removes it."},
    "watch_column": {"verdict": "write", "reason": "watch column creates or appends Basecamp state; it has side effects."},
    "subscribe_to_card_column": {"verdict": "write", "reason": "subscribe to card column creates or appends Basecamp state; it has side effects."},
    "unwatch_column": {"verdict": "destructive", "reason": "unwatch column changes existing Basecamp state or removes it."},
    "unsubscribe_from_card_column": {"verdict": "destructive", "reason": "unsubscribe from card column changes existing Basecamp state or removes it."},
    "create_wormhole": {"verdict": "write", "reason": "create wormhole creates or appends Basecamp state; it has side effects."},
    "update_wormhole": {"verdict": "destructive", "reason": "update wormhole changes existing Basecamp state or removes it."},
    "delete_wormhole": {"verdict": "destructive", "reason": "delete wormhole changes existing Basecamp state or removes it."},
    "create_card": {"verdict": "write", "reason": "create card creates or appends Basecamp state; it has side effects."},
    "update_card": {"verdict": "destructive", "reason": "update card changes existing Basecamp state or removes it."},
    "move_card": {"verdict": "destructive", "reason": "move card changes existing Basecamp state or removes it."},
    "trash_card": {"verdict": "destructive", "reason": "trash card changes existing Basecamp state or removes it."},
    "create_card_step": {"verdict": "write", "reason": "create card step creates or appends Basecamp state; it has side effects."},
    "update_card_step": {"verdict": "destructive", "reason": "update card step changes existing Basecamp state or removes it."},
    "complete_card_step": {"verdict": "destructive", "reason": "complete card step changes existing Basecamp state or removes it."},
    "uncomplete_card_step": {"verdict": "destructive", "reason": "uncomplete card step changes existing Basecamp state or removes it."},
    "reposition_card_step": {"verdict": "destructive", "reason": "reposition card step changes existing Basecamp state or removes it."},
    "delete_card_step": {"verdict": "destructive", "reason": "delete card step changes existing Basecamp state or removes it."},
    "create_campfire_line": {"verdict": "write", "reason": "create campfire line creates or appends Basecamp state; it has side effects."},
    "create_campfire_upload": {"verdict": "write", "reason": "create campfire upload creates or appends Basecamp state; it has side effects."},
    "delete_campfire_line": {"verdict": "destructive", "reason": "delete campfire line changes existing Basecamp state or removes it."},
    "create_schedule_entry": {"verdict": "write", "reason": "create schedule entry creates or appends Basecamp state; it has side effects."},
    "update_schedule_entry": {"verdict": "destructive", "reason": "update schedule entry changes existing Basecamp state or removes it."},
    "trash_schedule_entry": {"verdict": "destructive", "reason": "trash schedule entry changes existing Basecamp state or removes it."},
    "update_schedule_settings": {"verdict": "destructive", "reason": "update schedule settings changes existing Basecamp state or removes it."},
    "update_calendar": {"verdict": "destructive", "reason": "update calendar changes existing Basecamp state or removes it."},
    "create_lineup_marker": {"verdict": "write", "reason": "create lineup marker creates or appends Basecamp state; it has side effects."},
    "update_lineup_marker": {"verdict": "destructive", "reason": "update lineup marker changes existing Basecamp state or removes it."},
    "delete_lineup_marker": {"verdict": "destructive", "reason": "delete lineup marker changes existing Basecamp state or removes it."},
    "create_vault": {"verdict": "write", "reason": "create vault creates or appends Basecamp state; it has side effects."},
    "update_vault": {"verdict": "destructive", "reason": "update vault changes existing Basecamp state or removes it."},
    "create_document": {"verdict": "write", "reason": "create document creates or appends Basecamp state; it has side effects."},
    "update_document": {"verdict": "destructive", "reason": "update document changes existing Basecamp state or removes it."},
    "trash_document": {"verdict": "destructive", "reason": "trash document changes existing Basecamp state or removes it."},
    "create_attachment": {"verdict": "write", "reason": "create attachment creates or appends Basecamp state; it has side effects."},
    "create_upload": {"verdict": "write", "reason": "create upload creates or appends Basecamp state; it has side effects."},
    "update_upload": {"verdict": "destructive", "reason": "update upload changes existing Basecamp state or removes it."},
    "trash_upload": {"verdict": "destructive", "reason": "trash upload changes existing Basecamp state or removes it."},
    "create_cloud_file": {"verdict": "write", "reason": "create cloud file creates or appends Basecamp state; it has side effects."},
    "update_cloud_file": {"verdict": "destructive", "reason": "update cloud file changes existing Basecamp state or removes it."},
    "create_google_document": {"verdict": "write", "reason": "create google document creates or appends Basecamp state; it has side effects."},
    "update_google_document": {"verdict": "destructive", "reason": "update google document changes existing Basecamp state or removes it."},
    "create_question": {"verdict": "write", "reason": "create question creates or appends Basecamp state; it has side effects."},
    "update_question": {"verdict": "destructive", "reason": "update question changes existing Basecamp state or removes it."},
    "pause_question": {"verdict": "destructive", "reason": "pause question changes existing Basecamp state or removes it."},
    "resume_question": {"verdict": "destructive", "reason": "resume question changes existing Basecamp state or removes it."},
    "update_question_notification_settings": {"verdict": "destructive", "reason": "update question notification settings changes existing Basecamp state or removes it."},
    "create_answer": {"verdict": "write", "reason": "create answer creates or appends Basecamp state; it has side effects."},
    "update_answer": {"verdict": "destructive", "reason": "update answer changes existing Basecamp state or removes it."},
    "create_timesheet_entry": {"verdict": "write", "reason": "create timesheet entry creates or appends Basecamp state; it has side effects."},
    "update_timesheet_entry": {"verdict": "destructive", "reason": "update timesheet entry changes existing Basecamp state or removes it."},
    "destroy_timesheet_entry": {"verdict": "destructive", "reason": "destroy timesheet entry changes existing Basecamp state or removes it."},
    "toggle_gauge": {"verdict": "destructive", "reason": "toggle gauge changes existing Basecamp state or removes it."},
    "create_gauge_needle": {"verdict": "write", "reason": "create gauge needle creates or appends Basecamp state; it has side effects."},
    "update_gauge_needle": {"verdict": "destructive", "reason": "update gauge needle changes existing Basecamp state or removes it."},
    "destroy_gauge_needle": {"verdict": "destructive", "reason": "destroy gauge needle changes existing Basecamp state or removes it."},
  },
};

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

One account per authorization: ${purpose}${skill.fragments.guide_0}${grant}${skill.fragments.guide_1}${
    accountInstructions
      ? `\n## ${skill.instructionsHeading}\n\n${accountInstructions}\n`
      : ""
  }`;
}


/** The closed options basecamp() accepts; see `assertKnownOptions`. */
const BASECAMP_OPTIONS = optionsOf<BasecampOptions>()({ ...PROVIDER_COMMON, ...keys("clientMetadataUrl") });

/** A maintained Basecamp hosted-MCP connection. */
export const basecamp = defineProvider<BasecampOptions>({
  name: "basecamp",
  title: "Basecamp",
  kind: "mcp",
  readme: "Basecamp",
  bundle: {"baselineGzip":131228,"maxGzip":191228,"note":"./providers/basecamp starts at 131,228 B gzip, measured where it was introduced: a remoteMcp() wrapper like ./providers/revenuecat, so the same shape and the same baseline + 60,000 B policy."},
  skill,
  options: BASECAMP_OPTIONS,
  classify: BASECAMP_CLASSIFICATION,
  create: basecampConnector,
});

function basecampConnector(id: string, options: BasecampOptions, provider: ProviderContext): Connector {
  const purpose = options.purpose.trim();
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
    ...provider.connectorOptions,
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
    classify: provider.classify,
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
  });
  return connector;
}

/** @deprecated Read `basecamp.definition.classify` instead. Kept for existing imports. */
export const BASECAMP_VETTED_CATALOG = reviewedCatalog(
  basecamp.definition.classify!,
  'defineProvider("basecamp")',
);
