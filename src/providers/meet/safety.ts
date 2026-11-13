// Reviewed against archived Meet Discovery revision 20261109.
// Spaces, conference records, participants and artifacts are the user's own
// meeting data. Join details (meetingUri, meetingCode, dial-in PINs and SIP
// access codes) are what the space's organizer shares with invitees and what
// Calendar already shows them; they authorize joining one meeting, never an
// account, and remain available. Recording and transcript destinations are
// Drive and Docs file ids and their ordinary browser links, opened only with
// the reader's own Google access. No response carries a minted access URL.
import { safe, vendorErrors, type ValueSafetyTable } from "../_shared/rest/value-safety.js";

const joinDetails = [
  "meetingUri",
  "meetingCode",
  "config.entryPointAccess",
  "gatewaySipAccess",
  "gatewaySipAccess[].sipAccessCode",
] as const;
const join =
  "Join details are meeting information the organizer shares with invitees; they admit one person to one meeting under the space's access type, not to an account.";
const page = "nextPageToken is only a continuation, usable with the same grant; not an authentication credential.";

export const MEET_VALUE_SAFETY = {
  title: "Google Meet",
  embeddedUrls: {},
  operations: {
    "POST /spaces": vendorErrors(safe(join, joinDetails)),
    "GET /spaces/{spacesId}": vendorErrors(safe(join, joinDetails)),
    "PATCH /spaces/{spacesId}": vendorErrors(safe(join, joinDetails)),
    "GET /spaces/{spacesId}/members": vendorErrors(safe(page, ["nextPageToken"])),
    "GET /conferenceRecords": vendorErrors(safe(page, ["nextPageToken"])),
    "GET /conferenceRecords/{conferenceRecordsId}/participants": vendorErrors(safe(page, ["nextPageToken"])),
    "GET /conferenceRecords/{conferenceRecordsId}/participants/{participantsId}/participantSessions": vendorErrors(
      safe(page, ["nextPageToken"]),
    ),
    "GET /conferenceRecords/{conferenceRecordsId}/recordings": vendorErrors(safe(page, ["nextPageToken"])),
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts": vendorErrors(safe(page, ["nextPageToken"])),
    "GET /conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}/entries": vendorErrors(
      safe(page, ["nextPageToken"]),
    ),
    "GET /conferenceRecords/{conferenceRecordsId}/smartNotes": vendorErrors(safe(page, ["nextPageToken"])),
  },
  fields: {
    nextPageToken: {
      verdict: "keep",
      reason: "Opaque Meet pagination metadata, usable only with the same grant; not an access credential.",
    },
    meetingUri: { verdict: "keep", reason: join },
    meetingCode: { verdict: "keep", reason: join },
    entryPointAccess: {
      verdict: "keep",
      reason: "An enum naming which apps may join (ALL or CREATOR_APP_ONLY); it carries no access value.",
    },
    gatewaySipAccess: { verdict: "keep", reason: join },
    sipAccessCode: { verdict: "keep", reason: join },
  },
} as const satisfies ValueSafetyTable;
