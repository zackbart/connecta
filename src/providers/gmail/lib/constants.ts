/**
 * Gmail's API root, confined to the delegated user's own mailbox: `me` is the
 * token's subject, and no path can climb out of it.
 */
export const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Exactly the scopes this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list (comma-separated there).
 * `gmail.compose` technically permits sending; the tool surface does not.
 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

/** A full thread without attachment bodies; Gmail's message cap is 25 MB. */
export const GMAIL_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
