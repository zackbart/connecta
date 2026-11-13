// Public Meet constants, kept outside the kit declarations so the published
// entry names no Effect type.

/**
 * The Meet REST API root. Every path the tools send sits beneath `/spaces`
 * or `/conferenceRecords`; there is no user segment, because the token's
 * subject decides which spaces and conference records a request can reach.
 */
export const MEET_API_BASE_URL = "https://meet.googleapis.com/v2";

/**
 * Exactly the scopes this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list (comma-separated there).
 * `meetings.space.created` creates spaces and manages the ones this OAuth
 * client or service account created; `meetings.space.readonly` reads every
 * space and conference record the user can access; `meetings.space.settings`
 * reads and edits the settings of the user's own spaces.
 */
export const MEET_SCOPES = [
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.space.settings",
] as const;

/** A page of transcript entries at Google's own page maximum. */
export const MEET_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
