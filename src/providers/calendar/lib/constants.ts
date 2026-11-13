// Public Calendar constants, kept outside the kit declarations so the published
// entry names no Effect type.

/**
 * The Calendar API root. Every path the tools send sits beneath it; the
 * user's own calendar list and settings are addressed as `/users/me/...`, so
 * the token's subject is what decides whose calendars a request reaches.
 */
export const CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3";

/**
 * Exactly the scope this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list: full Calendar read and
 * write, the same scope comparable aggregators request.
 */
export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"] as const;

/** A week of busy recurring events with long descriptions and attendee lists. */
export const CALENDAR_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
