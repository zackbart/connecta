/** Reviewed against the ten pinned public product contracts; see evidence/review.md. */
import { safe, redact, type ValueSafetyTable } from "../_shared/rest/value-safety.js";
export const TABLE: ValueSafetyTable = {
  title: "Planning Center",
  embeddedUrls: {},
  fields: {
    "authenticity_secret": { verdict: "redact", reason: "Webhook HMAC verification key." },
    "secret": { verdict: "redact", reason: "Services organization credential." },
    "ical_code": { verdict: "redact", reason: "Private Services calendar-feed access code." },
    "payload": { verdict: "redact", reason: "Opaque JSON webhook payload can embed stored credentials." },
    "request_body": { verdict: "redact", reason: "Stored webhook request bytes can contain embedded credentials." },
    "response_body": {
      verdict: "redact",
      reason: "Third-party response bytes are not a reviewed credential-free shape.",
    },
    "request_headers": { verdict: "redact", reason: "Stored webhook headers can contain authentication values." },
    "response_headers": { verdict: "redact", reason: "Third-party headers can carry cookies and credentials." },
    "file_download_url": { verdict: "redact", reason: "A vendor-minted private file download can grant access." },
    signature: { verdict: "keep", reason: "Services Person email signature text, not a cryptographic signing value." },
    alternate_keys: { verdict: "keep", reason: "Musical keys for a song arrangement." },
  },
  resources: {
    key: "type",
    rules: {
      Attachment: {
        reason: "Attachment download and thumbnail addresses can grant file access.",
        paths: ["attributes.url", "attributes.thumbnail_url"],
      },
      AttachmentActivity: {
        reason: "Activity can copy a private attachment address.",
        paths: ["attributes.attachment_url"],
      },
      SongbookStatus: { reason: "An export download address can grant access.", paths: ["attributes.url"] },
    },
  },
  operations: {
    "GET /api/v2/personal_access_tokens": safe(
      "Token inventory returns names, ids, dates and revocation metadata, never the token value.",
      ["data[].attributes.last_used_on"],
    ),
    "GET /api/v2/personal_access_tokens/{personal_access_token_id}": safe(
      "Token inventory returns names, ids, dates and revocation metadata, never the token value.",
      ["data.attributes.last_used_on"],
    ),
    "GET /api/v2/personal_access_tokens/{personal_access_token_id}/person": safe(
      "Token inventory returns names, ids, dates and revocation metadata, never the token value.",
    ),
    "GET /api/v2/personal_access_tokens/{personal_access_token_id}/person/{person_id}": safe(
      "Token inventory returns names, ids, dates and revocation metadata, never the token value.",
    ),
    "POST /api/v2/personal_access_tokens/{personal_access_token_id}/revoke": safe(
      "Token inventory returns names, ids, dates and revocation metadata, never the token value.",
    ),
    "POST /groups/v2/groups/{group_id}/assign_campuses": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "GET /services/v2/me": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "POST /services/v2/media/{media_id}/assign_tags": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "GET /services/v2/people": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data[].attributes.signature", "included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "PATCH /services/v2/people/{person_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "POST /services/v2/people/{person_id}/assign_tags": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "GET /services/v2/people/{person_id}/person_team_position_assignments": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/person_team_position_assignments/{person_team_position_assignment_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "PATCH /services/v2/people/{person_id}/person_team_position_assignments/{person_team_position_assignment_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/plan_people": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/plan_people/{plan_person_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "PATCH /services/v2/people/{person_id}/plan_people/{plan_person_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/plan_people/{plan_person_id}/person": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data[].attributes.signature", "included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/plan_people/{plan_person_id}/person/{person_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "PATCH /services/v2/people/{person_id}/plan_people/{plan_person_id}/person/{person_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/plan_people/{plan_person_id}/team": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/plan_people/{plan_person_id}/team/{team_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/schedules/{schedule_id}/respond_to": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data[].attributes.signature", "included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/schedules/{schedule_id}/respond_to/{respond_to_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "PATCH /services/v2/people/{person_id}/schedules/{schedule_id}/respond_to/{respond_to_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/schedules/{schedule_id}/team": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/schedules/{schedule_id}/team/{team_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/team_leaders": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/team_leaders/{team_leader_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/team_leaders/{team_leader_id}/people": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data[].attributes.signature", "included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/team_leaders/{team_leader_id}/people/{person_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "PATCH /services/v2/people/{person_id}/team_leaders/{team_leader_id}/people/{person_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/team_leaders/{team_leader_id}/team": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/people/{person_id}/team_leaders/{team_leader_id}/team/{team_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/plans": redact("Stored credentials and opaque delivery headers stay withheld.", [
      "data[].attributes.secret",
    ]),
    "GET /services/v2/plans/{plan_id}": redact("Stored credentials and opaque delivery headers stay withheld.", [
      "data.attributes.secret",
    ]),
    "GET /services/v2/series/{series_id}/plans/{plan_id}/live/{live_id}/controller": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data[].attributes.signature", "included[].attributes.signature"],
    ),
    "GET /services/v2/series/{series_id}/plans/{plan_id}/live/{live_id}/controller/{controller_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "PATCH /services/v2/series/{series_id}/plans/{plan_id}/live/{live_id}/controller/{controller_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "GET /services/v2/series/{series_id}/plans/{plan_id}/live/{live_id}/items": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "GET /services/v2/series/{series_id}/plans/{plan_id}/live/{live_id}/items/{item_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "PATCH /services/v2/series/{series_id}/plans/{plan_id}/live/{live_id}/items/{item_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "GET /services/v2/series/{series_id}/plans/{plan_id}/needed_positions/{needed_position_id}/team": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/series/{series_id}/plans/{plan_id}/needed_positions/{needed_position_id}/team/{team_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plan_templates/{plan_template_id}/items": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "POST /services/v2/service_types/{service_type_id}/plan_templates/{plan_template_id}/items": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plan_templates/{plan_template_id}/items/{item_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "PATCH /services/v2/service_types/{service_type_id}/plan_templates/{plan_template_id}/items/{item_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plan_templates/{plan_template_id}/team_members": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "POST /services/v2/service_types/{service_type_id}/plan_templates/{plan_template_id}/team_members": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plan_templates/{plan_template_id}/team_members/{team_member_id}":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["included[].attributes.signature"],
      ),
    "PATCH /services/v2/service_types/{service_type_id}/plan_templates/{plan_template_id}/team_members/{team_member_id}":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["included[].attributes.signature"],
      ),
    "GET /services/v2/service_types/{service_type_id}/plan_times/{plan_time_id}/split_team_rehearsal_assignments/{split_team_rehearsal_assignment_id}/team":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["included[].attributes.signature"],
      ),
    "GET /services/v2/service_types/{service_type_id}/plan_times/{plan_time_id}/split_team_rehearsal_assignments/{split_team_rehearsal_assignment_id}/team/{team_id}":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["included[].attributes.signature"],
      ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/items": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "POST /services/v2/service_types/{service_type_id}/plans/{plan_id}/items": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/items/{item_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "PATCH /services/v2/service_types/{service_type_id}/plans/{plan_id}/items/{item_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/items/{item_id}/arrangement": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data[].links.keys", "included[].attributes.alternate_keys"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/items/{item_id}/arrangement/{arrangement_id}":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["data.links.keys", "included[].attributes.alternate_keys"],
      ),
    "PATCH /services/v2/service_types/{service_type_id}/plans/{plan_id}/items/{item_id}/arrangement/{arrangement_id}":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["data.links.keys", "included[].attributes.alternate_keys"],
      ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/items/{item_id}/key": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data[].attributes.alternate_keys"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/items/{item_id}/key/{key_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.alternate_keys"],
    ),
    "PATCH /services/v2/service_types/{service_type_id}/plans/{plan_id}/items/{item_id}/key/{key_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.alternate_keys"],
    ),
    "DELETE /services/v2/service_types/{service_type_id}/plans/{plan_id}/items/{item_id}/key/{key_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/live": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].attributes.signature", "included[].links.keys"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/live/{live_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].attributes.signature", "included[].links.keys"],
    ),
    "PATCH /services/v2/service_types/{service_type_id}/plans/{plan_id}/live/{live_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].attributes.signature", "included[].links.keys"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/needed_positions": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "POST /services/v2/service_types/{service_type_id}/plans/{plan_id}/needed_positions": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/needed_positions/{needed_position_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "PATCH /services/v2/service_types/{service_type_id}/plans/{plan_id}/needed_positions/{needed_position_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/signup_teams": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/signup_teams/{signup_team_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/team_members": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "POST /services/v2/service_types/{service_type_id}/plans/{plan_id}/team_members": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/team_members/{team_member_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "PATCH /services/v2/service_types/{service_type_id}/plans/{plan_id}/team_members/{team_member_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/team_positions": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}/person_team_position_assignments":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["included[].attributes.signature"],
      ),
    "POST /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}/person_team_position_assignments":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["included[].attributes.signature"],
      ),
    "GET /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}/person_team_position_assignments/{person_team_position_assignment_id}":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["included[].attributes.signature"],
      ),
    "PATCH /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}/person_team_position_assignments/{person_team_position_assignment_id}":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["included[].attributes.signature"],
      ),
    "GET /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}/person_team_position_assignments/{person_team_position_assignment_id}/person":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["data[].attributes.signature", "included[].attributes.signature"],
      ),
    "GET /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}/person_team_position_assignments/{person_team_position_assignment_id}/person/{person_id}":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["data.attributes.signature", "included[].attributes.signature"],
      ),
    "PATCH /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}/person_team_position_assignments/{person_team_position_assignment_id}/person/{person_id}":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["data.attributes.signature", "included[].attributes.signature"],
      ),
    "GET /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}/person_team_position_assignments/{person_team_position_assignment_id}/team_position":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["included[].attributes.signature"],
      ),
    "GET /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}/person_team_position_assignments/{person_team_position_assignment_id}/team_position/{team_position_id}":
      safe(
        "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
        ["included[].attributes.signature"],
      ),
    "GET /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}/team": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/team_positions/{team_position_id}/team/{team_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/teams": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "POST /services/v2/service_types/{service_type_id}/teams": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/service_types/{service_type_id}/teams/{team_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/songs/{song_id}/arrangements": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data[].links.keys", "included[].attributes.alternate_keys"],
    ),
    "POST /services/v2/songs/{song_id}/arrangements": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.links.keys", "included[].attributes.alternate_keys"],
    ),
    "GET /services/v2/songs/{song_id}/arrangements/{arrangement_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.links.keys", "included[].attributes.alternate_keys"],
    ),
    "PATCH /services/v2/songs/{song_id}/arrangements/{arrangement_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.links.keys", "included[].attributes.alternate_keys"],
    ),
    "POST /services/v2/songs/{song_id}/arrangements/{arrangement_id}/assign_tags": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "GET /services/v2/songs/{song_id}/arrangements/{arrangement_id}/keys": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data[].attributes.alternate_keys"],
    ),
    "POST /services/v2/songs/{song_id}/arrangements/{arrangement_id}/keys": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.alternate_keys"],
    ),
    "GET /services/v2/songs/{song_id}/arrangements/{arrangement_id}/keys/{key_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.alternate_keys"],
    ),
    "PATCH /services/v2/songs/{song_id}/arrangements/{arrangement_id}/keys/{key_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.alternate_keys"],
    ),
    "DELETE /services/v2/songs/{song_id}/arrangements/{arrangement_id}/keys/{key_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "GET /services/v2/songs/{song_id}/arrangements/{arrangement_id}/keys/{key_id}/attachments": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "POST /services/v2/songs/{song_id}/arrangements/{arrangement_id}/keys/{key_id}/attachments": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "GET /services/v2/songs/{song_id}/arrangements/{arrangement_id}/keys/{key_id}/attachments/{attachment_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "PATCH /services/v2/songs/{song_id}/arrangements/{arrangement_id}/keys/{key_id}/attachments/{attachment_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "DELETE /services/v2/songs/{song_id}/arrangements/{arrangement_id}/keys/{key_id}/attachments/{attachment_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "POST /services/v2/songs/{song_id}/assign_tags": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
    ),
    "GET /services/v2/songs/{song_id}/last_scheduled_item": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "GET /services/v2/songs/{song_id}/last_scheduled_item/{last_scheduled_item_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "PATCH /services/v2/songs/{song_id}/last_scheduled_item/{last_scheduled_item_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.alternate_keys", "included[].links.keys"],
    ),
    "GET /services/v2/songs/{song_id}/unscoped_arrangements": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data[].links.keys", "included[].attributes.alternate_keys"],
    ),
    "GET /services/v2/songs/{song_id}/unscoped_arrangements/{unscoped_arrangement_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.links.keys", "included[].attributes.alternate_keys"],
    ),
    "PATCH /services/v2/songs/{song_id}/unscoped_arrangements/{unscoped_arrangement_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.links.keys", "included[].attributes.alternate_keys"],
    ),
    "GET /services/v2/teams": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "POST /services/v2/teams": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/teams/{team_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/teams/{team_id}/people": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data[].attributes.signature", "included[].attributes.signature"],
    ),
    "GET /services/v2/teams/{team_id}/people/{person_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "PATCH /services/v2/teams/{team_id}/people/{person_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["data.attributes.signature", "included[].attributes.signature"],
    ),
    "GET /services/v2/teams/{team_id}/person_team_position_assignments": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/teams/{team_id}/person_team_position_assignments/{person_team_position_assignment_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "PATCH /services/v2/teams/{team_id}/person_team_position_assignments/{person_team_position_assignment_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/teams/{team_id}/team_leaders": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/teams/{team_id}/team_leaders/{team_leader_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/teams/{team_id}/team_positions": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /services/v2/teams/{team_id}/team_positions/{team_position_id}": safe(
      "Services signatures are email text and keys are musical notation; assign actions are relationship changes, not signing.",
      ["included[].attributes.signature"],
    ),
    "GET /webhooks/v2/available_events": safe(
      "Webhook event names and delivery status are metadata; opaque payloads and headers are withheld globally.",
    ),
    "GET /webhooks/v2/webhook_subscriptions": redact(
      "Stored credentials and opaque delivery headers stay withheld.",
      ["data[].attributes.authenticity_secret"],
      ["data[].links.rotate_secret"],
    ),
    "POST /webhooks/v2/webhook_subscriptions": redact(
      "Stored credentials and opaque delivery headers stay withheld.",
      ["data.attributes.authenticity_secret"],
      ["data.links.rotate_secret"],
    ),
    "GET /webhooks/v2/webhook_subscriptions/{webhook_subscription_id}": redact(
      "Stored credentials and opaque delivery headers stay withheld.",
      ["data.attributes.authenticity_secret"],
      ["data.links.rotate_secret"],
    ),
    "PATCH /webhooks/v2/webhook_subscriptions/{webhook_subscription_id}": redact(
      "Stored credentials and opaque delivery headers stay withheld.",
      ["data.attributes.authenticity_secret"],
      ["data.links.rotate_secret"],
    ),
    "DELETE /webhooks/v2/webhook_subscriptions/{webhook_subscription_id}": safe(
      "Webhook event names and delivery status are metadata; opaque payloads and headers are withheld globally.",
    ),
    "GET /webhooks/v2/webhook_subscriptions/{webhook_subscription_id}/events": safe(
      "Webhook event names and delivery status are metadata; opaque payloads and headers are withheld globally.",
    ),
    "GET /webhooks/v2/webhook_subscriptions/{webhook_subscription_id}/events/{event_id}": safe(
      "Webhook event names and delivery status are metadata; opaque payloads and headers are withheld globally.",
    ),
    "GET /webhooks/v2/webhook_subscriptions/{webhook_subscription_id}/events/{event_id}/deliveries": redact(
      "Stored credentials and opaque delivery headers stay withheld.",
      ["data[].attributes.request_headers", "data[].attributes.response_headers"],
    ),
    "GET /webhooks/v2/webhook_subscriptions/{webhook_subscription_id}/events/{event_id}/deliveries/{delivery_id}":
      redact("Stored credentials and opaque delivery headers stay withheld.", [
        "data.attributes.request_headers",
        "data.attributes.response_headers",
      ]),
    "POST /webhooks/v2/webhook_subscriptions/{webhook_subscription_id}/events/{event_id}/ignore": safe(
      "Webhook event names and delivery status are metadata; opaque payloads and headers are withheld globally.",
    ),
    "POST /webhooks/v2/webhook_subscriptions/{webhook_subscription_id}/events/{event_id}/redeliver": safe(
      "Webhook event names and delivery status are metadata; opaque payloads and headers are withheld globally.",
    ),
    "POST /webhooks/v2/webhook_subscriptions/{webhook_subscription_id}/rotate_secret": safe(
      "Webhook event names and delivery status are metadata; opaque payloads and headers are withheld globally.",
    ),
  },
};
