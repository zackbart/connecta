import { googlePageToken } from "../../../http/hatch-paging.js";
import { googleHatchBinding } from "../../_shared/google/hatch.js";
import { OperationIndex } from "../../_shared/rest/operation-index.js";
import type { Connection } from "../../../http/vendor.js";
import { openapi } from "../openapi.generated.js";

export const meetIndex = new OperationIndex(openapi, {
  vendor: "meet",
  title: "Google Meet",
  pathMatching: "uri-template",
});

/** The largest documented Meet page (members); Google coerces larger sizes down per method. */
const MAX_PAGE_SIZE = 500;
/** Members batch updates: Google's documented maximum per request. */
const MAX_MEMBER_UPDATES = 500;

const LISTS = new Set(
  meetIndex.ops.filter((op) => op.method === "GET" && op.operationId.endsWith(".list")).map((op) => op.path),
);

export function meetBinding(connection: Connection) {
  return googleHatchBinding(connection, {
    index: meetIndex,
    review:
      "Twenty-four reviewed Meet JSON methods, confined below /v2 with the delegated or connected subject and shared safety; space, conference and member writes are explicit.",
    refuse: (call) => {
      const pageSize = call.query["pageSize"];
      if (
        LISTS.has(call.op.path) &&
        pageSize !== undefined &&
        (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
      )
        return `Meet query.pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}; omit it for the default.`;
      if (call.op.path === "/spaces/{spacesId}/members:batchUpdate") {
        const requests = (call.body as { requests?: unknown } | undefined)?.requests;
        if (!Array.isArray(requests) || !requests.length || requests.length > MAX_MEMBER_UPDATES)
          return `A Meet members batch needs 1–${MAX_MEMBER_UPDATES} update requests.`;
      }
      return undefined;
    },
  });
}

export const MEET_HATCH = {
  name: "meet",
  title: "Google Meet",
  index: meetIndex,
  pathExample: "/conferenceRecords/conference_123",
  verdicts: {
    "POST /spaces": "write",
    "GET /spaces/{spacesId}": "read",
    "PATCH /spaces/{spacesId}": "destructive",
    "POST /spaces/{spacesId}:endActiveConference": "destructive",
    "GET /spaces/{spacesId}/members": "read",
    "GET /spaces/{spacesId}/members/{membersId}": "read",
    "POST /spaces/{spacesId}/members": "write",
    "PATCH /spaces/{spacesId}/members/{membersId}": "destructive",
    "POST /spaces/{spacesId}/members:batchUpdate": "destructive",
    "DELETE /spaces/{spacesId}/members/{membersId}": "destructive",
    "GET /conferenceRecords": "read",
    "GET /conferenceRecords/{conferenceRecordsId}": "read",
    "GET /conferenceRecords/{conferenceRecordsId}/participants": "read",
    "GET /conferenceRecords/{conferenceRecordsId}/participants/{participantsId}": "read",
    "GET /conferenceRecords/{conferenceRecordsId}/participants/{participantsId}/participantSessions": "read",
    "GET /conferenceRecords/{conferenceRecordsId}/participants/{participantsId}/participantSessions/{participantSessionsId}":
      "read",
    "GET /conferenceRecords/{conferenceRecordsId}/recordings": "read",
    "GET /conferenceRecords/{conferenceRecordsId}/recordings/{recordingsId}": "read",
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts": "read",
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}": "read",
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}/entries": "read",
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}/entries/{entriesId}": "read",
    "GET /conferenceRecords/{conferenceRecordsId}/smartNotes": "read",
    "GET /conferenceRecords/{conferenceRecordsId}/smartNotes/{smartNotesId}": "read",
  },
  named: {
    "POST /spaces": "create_space",
    "GET /spaces/{spacesId}": "get_space",
    "PATCH /spaces/{spacesId}": "update_space",
    "POST /spaces/{spacesId}:endActiveConference": "end_active_conference",
    "GET /conferenceRecords": "list_conference_records",
    "GET /conferenceRecords/{conferenceRecordsId}": "get_conference_record",
    "GET /conferenceRecords/{conferenceRecordsId}/participants": "list_participants",
    "GET /conferenceRecords/{conferenceRecordsId}/participants/{participantsId}": "get_participant",
    "GET /conferenceRecords/{conferenceRecordsId}/participants/{participantsId}/participantSessions":
      "list_participant_sessions",
    "GET /conferenceRecords/{conferenceRecordsId}/participants/{participantsId}/participantSessions/{participantSessionsId}":
      "get_participant_session",
    "GET /conferenceRecords/{conferenceRecordsId}/recordings": "list_recordings",
    "GET /conferenceRecords/{conferenceRecordsId}/recordings/{recordingsId}": "get_recording",
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts": "list_transcripts",
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}": "get_transcript",
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}/entries": "list_transcript_entries",
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}/entries/{entriesId}":
      "get_transcript_entry",
    "GET /conferenceRecords/{conferenceRecordsId}/smartNotes": "list_smart_notes",
    "GET /conferenceRecords/{conferenceRecordsId}/smartNotes/{smartNotesId}": "get_smart_note",
  },
  pages: {
    "GET /spaces/{spacesId}/members": googlePageToken,
    "GET /conferenceRecords": googlePageToken,
    "GET /conferenceRecords/{conferenceRecordsId}/participants": googlePageToken,
    "GET /conferenceRecords/{conferenceRecordsId}/participants/{participantsId}/participantSessions": googlePageToken,
    "GET /conferenceRecords/{conferenceRecordsId}/recordings": googlePageToken,
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts": googlePageToken,
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}/entries": googlePageToken,
    "GET /conferenceRecords/{conferenceRecordsId}/smartNotes": googlePageToken,
  },
  pageCursor: "argument",
} as const;
