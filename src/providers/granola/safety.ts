import { safe, redact, refuse, type ValueSafetyTable } from "../_shared/rest/value-safety.js";
import { openapi } from "./openapi.generated.js";

export const READS = new Set([
  "GET /v1/notes",
  "GET /v1/notes/{note_id}",
  "GET /v1/notes/{note_id}/transcript",
  "GET /v1/folders",
  "GET /v1/spaces",
]);
export const GRANOLA_VALUE_SAFETY: ValueSafetyTable = {
  title: "Granola",
  operations: Object.fromEntries(
    openapi.ops.map(([method, path]) => {
      const key = `${method} ${path}`;
      return [
        key,
        !READS.has(key)
          ? refuse(
              "Only notes, note details, transcripts, folders and spaces are reviewed. Audit, legal holds, webhook management and writes are unavailable.",
            )
          : key === "GET /v1/notes/{note_id}"
            ? redact(
                "Photo URLs grant unauthenticated access and are always withheld. Private handwritten note content (vendor-null for workspace keys) and space memberships describe API-key visibility, not credentials; their nested values still cross value safety.",
                ["attachments[].url"],
                ["private_notes_text", "private_notes_markdown", "space_membership"],
              )
            : safe(
                "Read-only meeting content and identifiers; no API credential is returned. Vendor error prose stays withheld.",
              ),
      ];
    }),
  ),
  embeddedUrls: {
    operations: {
      "GET /v1/notes": ["notes[].title"],
      "GET /v1/notes/{note_id}": [
        "title",
        "summary_text",
        "summary_markdown",
        "private_notes_text",
        "private_notes_markdown",
        "transcript[].text",
      ],
      "GET /v1/notes/{note_id}/transcript": ["transcript[].text"],
    },
  },
};
