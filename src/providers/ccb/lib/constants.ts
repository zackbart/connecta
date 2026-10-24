/** CCB's v2 media type. The API and its token endpoint both require it. */
export const CCB_MEDIA_TYPE = "application/vnd.ccbchurch.v2+json";

/**
 * The two published environments. Credentials do not cross: sandbox clients
 * work only against the sandbox hosts and production clients only against
 * production, so the environment is part of the client, not a preference.
 */
export const CCB_ENVIRONMENTS = {
  production: {
    apiOrigin: "https://api.ccbchurch.com",
    authorizationEndpoint: "https://oauth.ccbchurch.com/oauth/authorize",
  },
  sandbox: {
    apiOrigin: "https://api-beta.ccbchurch.com",
    authorizationEndpoint: "https://beta-oauth.ccbchurch.com/oauth/authorize",
  },
} as const;

/**
 * The read scopes the named tools and the search hatch need, from the
 * `security` requirements of the operations they call (spec revision recorded
 * in the drift manifest). `read:campuses` and `read:church` are there so the
 * ids every projection carries — campus, membership type — can be resolved
 * through `ccb_api_read`. Request these on Pushpay's API access form.
 */
export const CCB_READ_SCOPES: readonly string[] = [
  "read:advanced_searches",
  "read:campuses",
  "read:church",
  "read:event_attendance",
  "read:events",
  "read:forms",
  "read:group_members",
  "read:groups",
  "read:individual_groups",
  "read:individual_notes",
  "read:individual_pledges",
  "read:individuals",
  "read:individuals_metrics",
  "read:process_queues",
  "read:queue_individuals",
  "read:scheduling",
];

/**
 * What `access: "read-write"` adds: the writes of the everyday staff jobs —
 * profiles, groups, events and attendance, form responses, notes, process
 * queues, scheduling. No `delete:` scope, nothing financial, no background
 * checks, and no privacy settings: those are deliberate, so they are only
 * ever requested through an explicit `scopes` list.
 */
export const CCB_WRITE_SCOPES: readonly string[] = [
  "write:event_attendance",
  "write:events",
  "write:form_responses",
  "write:group_members",
  "write:groups",
  "write:individual_groups",
  "write:individual_notes",
  "write:individuals",
  "write:notes",
  "write:queue_individuals",
  "write:scheduling",
];

export const CCB_SENSITIVE_FIELDS: readonly string[] = [
  "allergies",
  "confirmed_no_allergies",
  "giving_number",
  "envelope_user_id",
  "last_giving_date",
  "date_anyone_run_giving_statement",
  "date_family_run_giving_statement",
  "prayer_requests",
  "notes",
  "payment",
];
