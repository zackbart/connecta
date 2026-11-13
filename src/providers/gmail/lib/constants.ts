/**
 * Gmail's API root, confined to the delegated user's own mailbox: `me` is the
 * token's subject, and no path can climb out of it.
 */
export const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Exactly the scopes this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list (comma-separated there).
 * Full mailbox access, including permanent deletion, plus the two settings
 * scopes: `gmail.settings.basic` for filters, vacation, IMAP/POP and language,
 * and `gmail.settings.sharing` for forwarding, delegates and send-as aliases,
 * whose writes no other scope admits.
 */
export const GMAIL_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
] as const;

/** A full thread without attachment bodies; Gmail's message cap is 25 MB. */
export const GMAIL_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
