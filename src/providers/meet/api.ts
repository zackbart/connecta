// Google Meet's vendor on the provider kit: the operations the tools send,
// the product facts the shared Google table words its failures with, and the
// value-safety resolver over those operations.
import { Schema } from "effect";
import { get, patch, post, vendor } from "../../http/vendor.js";
import { googleErrors, type GoogleProduct } from "../_shared/google/kit.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { meetIndex } from "./lib/hatch.js";
import { MEET_VALUE_SAFETY } from "./safety.js";
import { MEET_SCOPES } from "./lib/constants.js";

export const MEET: GoogleProduct = {
  provider: "Google Meet",
  api: "Google Meet REST API",
  scopes: MEET_SCOPES,
  // A space or conference record the user cannot see answers like one that
  // does not exist, so a 404 is not proof of absence.
  notFound: "ambiguous",
};

const Page = {
  pageSize: Schema.optionalKey(Schema.String),
  pageToken: Schema.optionalKey(Schema.String),
};
const Space = { spacesId: Schema.String };
const Conference = { conferenceRecordsId: Schema.String };
const Participant = { ...Conference, participantsId: Schema.String };
const Transcript = { ...Conference, transcriptsId: Schema.String };

const getSpace = get("getSpace", "/spaces/:spacesId", { params: Space, success: Schema.Unknown });

const OPERATIONS = [
  post("createSpace", "/spaces", { payload: Schema.Unknown, success: Schema.Unknown }),
  getSpace,
  patch("updateSpace", "/spaces/:spacesId", {
    params: Space,
    query: { updateMask: Schema.optionalKey(Schema.String) },
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("endActiveConference", "/spaces/:spacesId:endActiveConference", {
    params: Space,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  get("listConferenceRecords", "/conferenceRecords", {
    query: { ...Page, filter: Schema.optionalKey(Schema.String) },
    success: Schema.Unknown,
  }),
  get("getConferenceRecord", "/conferenceRecords/:conferenceRecordsId", {
    params: Conference,
    success: Schema.Unknown,
  }),
  get("listParticipants", "/conferenceRecords/:conferenceRecordsId/participants", {
    params: Conference,
    query: { ...Page, filter: Schema.optionalKey(Schema.String) },
    success: Schema.Unknown,
  }),
  get("getParticipant", "/conferenceRecords/:conferenceRecordsId/participants/:participantsId", {
    params: Participant,
    success: Schema.Unknown,
  }),
  get(
    "listParticipantSessions",
    "/conferenceRecords/:conferenceRecordsId/participants/:participantsId/participantSessions",
    { params: Participant, query: { ...Page, filter: Schema.optionalKey(Schema.String) }, success: Schema.Unknown },
  ),
  get(
    "getParticipantSession",
    "/conferenceRecords/:conferenceRecordsId/participants/:participantsId/participantSessions/:participantSessionsId",
    { params: { ...Participant, participantSessionsId: Schema.String }, success: Schema.Unknown },
  ),
  get("listRecordings", "/conferenceRecords/:conferenceRecordsId/recordings", {
    params: Conference,
    query: Page,
    success: Schema.Unknown,
  }),
  get("getRecording", "/conferenceRecords/:conferenceRecordsId/recordings/:recordingsId", {
    params: { ...Conference, recordingsId: Schema.String },
    success: Schema.Unknown,
  }),
  get("listTranscripts", "/conferenceRecords/:conferenceRecordsId/transcripts", {
    params: Conference,
    query: Page,
    success: Schema.Unknown,
  }),
  get("getTranscript", "/conferenceRecords/:conferenceRecordsId/transcripts/:transcriptsId", {
    params: Transcript,
    success: Schema.Unknown,
  }),
  get("listTranscriptEntries", "/conferenceRecords/:conferenceRecordsId/transcripts/:transcriptsId/entries", {
    params: Transcript,
    query: Page,
    success: Schema.Unknown,
  }),
  get("getTranscriptEntry", "/conferenceRecords/:conferenceRecordsId/transcripts/:transcriptsId/entries/:entriesId", {
    params: { ...Transcript, entriesId: Schema.String },
    success: Schema.Unknown,
  }),
  get("listSmartNotes", "/conferenceRecords/:conferenceRecordsId/smartNotes", {
    params: Conference,
    query: Page,
    success: Schema.Unknown,
  }),
  get("getSmartNote", "/conferenceRecords/:conferenceRecordsId/smartNotes/:smartNotesId", {
    params: { ...Conference, smartNotesId: Schema.String },
    success: Schema.Unknown,
  }),
] as const;

/** The eighteen Meet methods the tools call, published under `/v2` as Google's Discovery document spells them. */
export const MeetApi = vendor({ name: "Google Meet", manifestBase: "/v2" }, ...OPERATIONS);

export const errors = googleErrors(MEET, { standard: true });

const values = valueSafety(MEET_VALUE_SAFETY, () => meetIndex);
export const safety = {
  reviewed: {
    resolve: (method: string, path: string) => {
      const op = meetIndex.resolve(method, path).op;
      return { method: op.method, template: op.path };
    },
    redact: (data: unknown, op: { method: string; template: string }) => values.redact(data, op.method, op.template),
    withholds: (op: { method: string; template: string }) => values.withholds(op.method, op.template),
    withholdsErrors: (op: { method: string; template: string }) =>
      values.withholdsErrors(meetIndex.ops.find((entry) => entry.method === op.method && entry.path === op.template)!),
  },
  sensitiveFields: { names: [], choice: "drop" },
} as const;

/**
 * Delegation has no operator credential to test: the key is a deployment
 * secret read at construction. This probe is never run, because the
 * connection declares no credential.
 */
export const probe = {
  operation: getSpace,
  request: { params: { spacesId: "-" } },
  describe: () => "Google Meet delegation has no credential to test.",
};
