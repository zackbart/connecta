/**
 * The Sheets API root. Every path the tools send is beneath
 * `/spreadsheets`; the delegated token decides which ones the user can open.
 */
export const SHEETS_API_BASE_URL = "https://sheets.googleapis.com/v4";

/**
 * Exactly the scope this connection requests, and what the Admin console's
 * domain-wide delegation entry must add for it. One scope reads and writes
 * every spreadsheet the user can open; Google offers no narrower one that
 * writes.
 */
export const SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"] as const;

/** A wide values read; Google itself recommends payloads under 2 MB. */
export const SHEETS_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
