/** The Slides API root. Every path beneath it names a presentation by id. */
export const SLIDES_API_BASE_URL = "https://slides.googleapis.com/v1";

/**
 * Exactly the scope this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list for it. `presentations`
 * reads and writes every deck the user can open; Slides offers nothing
 * narrower that can also write.
 */
export const SLIDES_SCOPES = ["https://www.googleapis.com/auth/presentations"] as const;

/** A whole presentation without styles; with raw: true, with them. */
export const SLIDES_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
