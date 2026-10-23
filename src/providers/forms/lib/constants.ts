// Public Forms constants, kept outside the kit declarations so the published
// entry names no Effect type.

/**
 * The Forms API root. Every path the tools send sits beneath `/forms`; there
 * is no user segment, because a form is a Drive file the token's subject can
 * or cannot open.
 */
export const FORMS_API_BASE_URL = "https://forms.googleapis.com/v1";

/**
 * Exactly the scopes this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list (comma-separated there).
 * `forms.body` reads and edits forms; responses are read-only.
 */
export const FORMS_SCOPES = [
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/forms.responses.readonly",
] as const;

/** A large form with embedded media metadata, or a page of long answers. */
export const FORMS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
