import { asArray, asRecord, compact } from "../_shared/json.js";
// Meet spaces, conference records and artifacts on the standard provider kit.
import { Effect, Option, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import type { Connection } from "../../http/vendor.js";
import type { ConnectorContext } from "../../types.js";
import { clampText, jsonBytes, RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import { googleClient, googleFailureMessage, googleOutcomeOf } from "../_shared/google/kit.js";
import { encodeForAgent, redactSentSecrets } from "../../sent-secrets.js";
import { Integer, isMaxChars, isMinChars } from "../../http/json-schema.js";
import { boundCursor, Cursor, StandardPage } from "../../http/paging.js";
import { read, write } from "../../http/tools.js";
import { fieldsContract, selectFields } from "../../http/fields.js";
import { Refusal } from "../../http/errors.js";
import type { ArgumentProblems } from "../../http/argument-problems.js";
import { Operation } from "../../runtime/call.js";
import { meetIndex } from "./lib/hatch.js";

type JsonRecord = Record<string, any>;

/** A listed transcript entry's text is cut here; get_transcript_entry returns it whole. */
const LIST_TEXT_BYTES = 3 * 1024;

const contextOf = Effect.gen(function* () {
  const operation = yield* Effect.serviceOption(Operation);
  if (Option.isNone(operation) || !operation.value) return yield* Effect.die(new Error("Missing Meet call context."));
  return operation.value;
});
const knownFailures = Effect.catchDefect((error: unknown) =>
  error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
);

// --- Effect schemas: catalog and runtime decoding share these declarations. ---

const pattern = (source: string) =>
  Schema.makeFilter((value: string) => new RegExp(source).test(value), { toJsonSchema: () => ({ pattern: source }) });
const ID = "[A-Za-z0-9_.~-]{1,256}";
const name = (description: string, source: string) =>
  Schema.String.check(isMinChars(1), isMaxChars(1024), pattern(source)).annotate({ description });
const optional = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Schema.optionalKey(value)])));
const literals = <const L extends readonly [string, ...string[]]>(values: L, description: string) =>
  Schema.Literals(values).annotate({ description });
const instant = (description: string) =>
  Schema.String.check(pattern("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$")).annotate({ description });

const MEETING_CODE = /^[a-z]+-[a-z]+-[a-z]+$/;
const spaceRef = name(
  "Space name spaces/<id>, a meeting code such as abc-mnop-xyz, or its https://meet.google.com/ link.",
  "^(?:spaces/|https://meet\\.google\\.com/)?[A-Za-z0-9_-]{1,128}$",
);
const spaceName = name(
  "Space name spaces/<id> from get_space or create_space; a meeting code is not accepted here.",
  "^spaces/[A-Za-z0-9_-]{1,128}$",
);
const conferenceRecord = name(
  "Conference record name conferenceRecords/<id> from list_conference_records or a space's activeConference.",
  `^conferenceRecords/${ID}$`,
);
const participantName = name(
  "Participant name conferenceRecords/<id>/participants/<id> from list_participants.",
  `^conferenceRecords/${ID}/participants/${ID}$`,
);
const transcriptName = name(
  "Transcript name conferenceRecords/<id>/transcripts/<id> from list_transcripts.",
  `^conferenceRecords/${ID}/transcripts/${ID}$`,
);
const activeOnly = Schema.Boolean.annotate({ description: "Only those still in the meeting (no end time yet)." });

const SpaceRecord = optional({
  name: Schema.String,
  meetingUri: Schema.String,
  meetingCode: Schema.String,
  config: Schema.Unknown,
  activeConference: optional({ conferenceRecord: Schema.String }),
  phoneAccess: Schema.Array(
    optional({
      phoneNumber: Schema.String,
      pin: Schema.String,
      regionCode: Schema.String,
      languageCode: Schema.String,
    }),
  ),
  gatewaySipAccess: Schema.Array(optional({ uri: Schema.String, sipAccessCode: Schema.String })),
});
const ConferenceRecordRow = optional({
  name: Schema.String,
  space: Schema.String,
  startTime: Schema.String,
  endTime: Schema.String,
  expireTime: Schema.String,
});
const User = optional({ user: Schema.String, displayName: Schema.String });
const ParticipantRow = optional({
  name: Schema.String,
  earliestStartTime: Schema.String,
  latestEndTime: Schema.String,
  signedinUser: User,
  anonymousUser: optional({ displayName: Schema.String }),
  phoneUser: optional({ displayName: Schema.String }),
});
const SessionRow = optional({ name: Schema.String, startTime: Schema.String, endTime: Schema.String });
const Times = { name: Schema.String, state: Schema.String, startTime: Schema.String, endTime: Schema.String };
const RecordingRow = optional({
  ...Times,
  driveDestination: optional({ file: Schema.String, exportUri: Schema.String }),
});
const DocsRow = optional({
  ...Times,
  docsDestination: optional({ document: Schema.String, exportUri: Schema.String }),
});
const EntryRow = optional({
  name: Schema.String,
  participant: Schema.String,
  text: Schema.String,
  languageCode: Schema.String,
  startTime: Schema.String,
  endTime: Schema.String,
});

/** Keep only the keys a declared output names, recursively, so a new vendor field never widens a result. */
function project(value: unknown, shape: Schema.Top): JsonRecord {
  const fields = (shape as unknown as { fields?: Record<string, Schema.Top> }).fields ?? {};
  const record = asRecord(value);
  const out: JsonRecord = {};
  for (const [key, field] of Object.entries(fields)) {
    const entry = record[key];
    if (entry === undefined || entry === null) continue;
    const inner = (field as unknown as { schema?: Schema.Top }).schema ?? field;
    const nested = (inner as unknown as { fields?: unknown }).fields;
    const item = (inner as unknown as { schema?: Schema.Top; rest?: unknown }).schema;
    if (nested) out[key] = project(entry, inner);
    else if (Array.isArray(entry))
      out[key] = entry.map((element) =>
        (item as unknown as { fields?: unknown })?.fields ? project(element, item!) : element,
      );
    else out[key] = entry;
  }
  return out;
}

// --- Resource names ----------------------------------------------------------------

/** A validated resource name as a request path: each segment encoded, literals intact. */
function pathOf(resource: string): string {
  return `/${resource.split("/").map(encodeURIComponent).join("/")}`;
}

/** The space id a reference names: a space name, a meeting code, or a meeting link. */
function spaceId(reference: string): string {
  return reference.replace(/^(?:spaces\/|https:\/\/meet\.google\.com\/)/, "");
}

/** Google's continuation token, refused when malformed or when it echoes a value this request sent. */
function nextToken(ctx: ConnectorContext, value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new ConnectorCallError("connector_call_failed", "Google returned malformed Meet paging metadata.");
  const redacted = redactSentSecrets(ctx, value);
  if (redacted !== value || redacted.includes("[redacted]"))
    throw new ConnectorCallError(
      "connector_call_failed",
      "Google returned a withheld Meet page token; continuation is unavailable.",
    );
  return value;
}

// --- Space configuration -------------------------------------------------------------

const ON_OFF = (description: string) => Schema.Boolean.annotate({ description });
const restriction = (what: string) =>
  literals(["HOSTS_ONLY", "NO_RESTRICTION"], `Who may ${what} while moderation is on.`);

/** Space settings as flat arguments, each with the Google config path it sets. */
const SETTINGS = {
  accessType: {
    schema: literals(
      ["OPEN", "TRUSTED", "RESTRICTED"],
      "Who joins without knocking: OPEN anyone with the link, TRUSTED the organization and invitees, RESTRICTED invitees only.",
    ),
    path: "accessType",
  },
  entryPointAccess: {
    schema: literals(["ALL", "CREATOR_APP_ONLY"], "Join from any Meet entry point, or only from the creating app."),
    path: "entryPointAccess",
  },
  moderation: { schema: ON_OFF("Turn host management (moderation) on or off."), path: "moderation" },
  chatRestriction: { schema: restriction("send chat messages"), path: "moderationRestrictions.chatRestriction" },
  reactionRestriction: { schema: restriction("send reactions"), path: "moderationRestrictions.reactionRestriction" },
  presentRestriction: { schema: restriction("share their screen"), path: "moderationRestrictions.presentRestriction" },
  defaultJoinAsViewer: {
    schema: ON_OFF("While moderated, join people as viewers by default."),
    path: "moderationRestrictions.defaultJoinAsViewerType",
  },
  attendanceReport: {
    schema: ON_OFF("Save an attendance report to the organizer's Drive."),
    path: "attendanceReportGenerationType",
  },
  autoRecording: {
    schema: ON_OFF("Record automatically when someone allowed to record joins."),
    path: "artifactConfig.recordingConfig.autoRecordingGeneration",
  },
  autoTranscription: {
    schema: ON_OFF("Transcribe automatically when someone allowed to transcribe joins."),
    path: "artifactConfig.transcriptionConfig.autoTranscriptionGeneration",
  },
  autoSmartNotes: {
    schema: ON_OFF("Take Gemini notes automatically when someone allowed to enable them joins."),
    path: "artifactConfig.smartNotesConfig.autoSmartNotesGeneration",
  },
} as const;
type Setting = keyof typeof SETTINGS;
const SETTING_KEYS = Object.keys(SETTINGS) as Setting[];
const settingFields = Object.fromEntries(
  SETTING_KEYS.map((key) => [key, Schema.optionalKey(SETTINGS[key].schema)]),
) as { [K in Setting]: Schema.optionalKey<(typeof SETTINGS)[K]["schema"]> };

/** The Google wire value of one flat setting. */
function wire(key: Setting, value: unknown): string {
  if (typeof value !== "boolean") return String(value);
  if (key === "attendanceReport") return value ? "GENERATE_REPORT" : "DO_NOT_GENERATE";
  return value ? "ON" : "OFF";
}

/** The supplied settings as Google's SpaceConfig, and the update mask that names exactly them. */
function spaceConfig(args: Readonly<Record<string, unknown>>): { config: JsonRecord; mask: string[] } {
  const config: JsonRecord = {};
  const mask: string[] = [];
  for (const key of SETTING_KEYS) {
    if (args[key] === undefined) continue;
    const parts = SETTINGS[key].path.split(".");
    let target = config;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)!] = wire(key, args[key]);
    mask.push(`config.${SETTINGS[key].path}`);
  }
  return { config, mask };
}

// --- Lists ------------------------------------------------------------------------------

interface ListSpec<F extends Schema.Struct.Fields> {
  readonly name: string;
  readonly description: string;
  readonly filters: F;
  readonly row: Schema.Top;
  /** Google's key for the rows in a page. */
  readonly key: string;
  readonly limit: { readonly default: number; readonly max: number; readonly noun: string };
  readonly request: (args: Schema.Struct<F>["Type"]) => {
    readonly path: string;
    readonly template: string;
    readonly filter?: string;
  };
  /** Bound one projected row; returns whether anything was cut. */
  readonly fit?: (ctx: ConnectorContext, row: JsonRecord) => boolean;
  readonly truncatedPath?: string;
}

/**
 * One Google page per call: `{ items, page }`, with a cursor bound to this
 * tool, these arguments, the connection and its owner. A page returns whole;
 * the row bounds keep the largest page inside one result.
 */
function list<F extends Schema.Struct.Fields>(
  connection: Connection,
  client: ReturnType<typeof googleClient>,
  spec: ListSpec<F>,
): ApiTool {
  const contract = fieldsContract("item", spec.row);
  const input = Schema.Struct({
    ...spec.filters,
    limit: Schema.optionalKey(
      Integer.check(Schema.isBetween({ minimum: 1, maximum: spec.limit.max })).annotate({
        description: `Maximum ${spec.limit.noun}; default ${spec.limit.default}, at most ${spec.limit.max}.`,
        default: spec.limit.default,
      }),
    ),
    cursor: Schema.optionalKey(Cursor),
    fields: Schema.optionalKey(contract.input),
  });
  return read(connection, {
    name: spec.name,
    description: spec.description,
    input,
    output: Schema.Struct({
      items: Schema.Array(spec.row),
      page: StandardPage,
      truncated: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
    check: (args: { readonly fields?: readonly string[] }, problems: ArgumentProblems) =>
      contract.issues(problems, args.fields),
    run: (args: JsonRecord) =>
      Effect.gen(function* () {
        const ctx = yield* contextOf;
        const { fields, limit, cursor, ...filters } = args;
        const binding = compact({ ...filters });
        const token = typeof cursor === "string" ? yield* boundCursor.decode(spec.name, binding, cursor) : undefined;
        const request = spec.request(filters as Schema.Struct<F>["Type"]);
        const answer = asRecord(
          yield* client.json({
            method: "GET",
            path: request.path,
            template: request.template,
            query: {
              pageSize: typeof limit === "number" ? limit : spec.limit.default,
              pageToken: token,
              filter: request.filter,
            },
          }),
        );
        let cut = false;
        const rows = asArray(answer[spec.key]).map((value) => {
          const row = project(value, spec.row);
          if (spec.fit?.(ctx, row)) cut = true;
          return row;
        });
        const next = nextToken(ctx, answer["nextPageToken"]);
        const nextCursor = next
          ? yield* boundCursor.encode(spec.name, binding, next, (json) =>
              encodeForAgent(ctx, json, { url: true, claims: true }),
            )
          : undefined;
        const result = {
          items: selectFields(rows, fields) as JsonRecord[],
          page: { hasMore: nextCursor !== undefined, ...(nextCursor ? { nextCursor } : {}) },
          ...(cut && spec.truncatedPath ? { truncated: [spec.truncatedPath] } : {}),
        };
        if (jsonBytes(result) > RESULT_BUDGET_BYTES)
          throw new ConnectorCallError(
            "connector_call_failed",
            `This page of ${spec.limit.noun} does not fit one result (${RESULT_BUDGET_BYTES} bytes); pass a smaller limit.`,
            { retryable: false },
          );
        return result;
      }).pipe(knownFailures),
    // The spec is generic over its filters, which the builder's input type cannot name.
  } as never);
}

/** A named read of one resource: the projected record, narrowed by `fields`. */
function getOne(
  connection: Connection,
  client: ReturnType<typeof googleClient>,
  spec: {
    readonly name: string;
    readonly description: string;
    readonly argument: string;
    readonly input: Schema.Top;
    readonly row: Schema.Top;
    readonly template: string;
  },
): ApiTool {
  return read(connection, {
    name: spec.name,
    description: spec.description,
    input: Schema.Struct({ [spec.argument]: spec.input }),
    output: spec.row,
    fields: true,
    run: (args: JsonRecord) =>
      Effect.map(client.json({ method: "GET", path: pathOf(args[spec.argument]), template: spec.template }), (answer) =>
        project(answer, spec.row),
      ),
    // The argument name is data, which the builder's input type cannot name.
  } as never);
}

// --- Tools ------------------------------------------------------------------------------

export function meetTools({ connection }: { connection: Connection }): ApiTool[] {
  const client = googleClient(connection, meetIndex);
  const conference = "/conferenceRecords/{conferenceRecordsId}";
  const participant = `${conference}/participants/{participantsId}`;
  const transcript = `${conference}/transcripts/{transcriptsId}`;
  const fitEntry = (ctx: ConnectorContext, row: JsonRecord) => {
    if (typeof row["text"] !== "string") return false;
    const text = clampText(
      ctx,
      row["text"],
      LIST_TEXT_BYTES,
      (dropped) => `\n[… ${dropped} more characters truncated; get_transcript_entry reads it whole]`,
    );
    const cut = text !== row["text"];
    row["text"] = text;
    return cut;
  };
  const artifacts = (kind: "recordings" | "transcripts" | "smartNotes", noun: string, row: Schema.Top) =>
    list(connection, client, {
      name: `list_${kind === "smartNotes" ? "smart_notes" : kind}`,
      description:
        kind === "recordings"
          ? "List a conference's recordings in start order: state, times and the Drive MP4 file id. Not the video itself."
          : kind === "transcripts"
            ? "List a conference's transcripts in start order: state, times and the Google Docs file id. list_transcript_entries reads the speech."
            : "List a conference's Gemini smart notes in start order: state, times and the Google Docs file id holding the summary.",
      filters: { conferenceRecord },
      row,
      key: kind,
      limit: { default: 10, max: 100, noun },
      request: (args) => ({
        path: `${pathOf(args.conferenceRecord)}/${kind}`,
        template: `${conference}/${kind}`,
      }),
    });
  const artifact = (kind: "recordings" | "transcripts" | "smartNotes", single: string, row: Schema.Top) =>
    getOne(connection, client, {
      name: `get_${single}`,
      description:
        kind === "recordings"
          ? "Get one Meet recording: state, times and the Drive MP4 file id to open with Drive."
          : kind === "transcripts"
            ? "Get one Meet transcript: state, times and the Google Docs file id to read with Docs."
            : "Get one Gemini smart notes record: state, times and the Google Docs file id holding the summary.",
      argument: "name",
      input: name(
        `${single.replaceAll("_", " ")} name conferenceRecords/<id>/${kind}/<id> from list_${kind === "smartNotes" ? "smart_notes" : kind}.`,
        `^conferenceRecords/${ID}/${kind}/${ID}$`,
      ),
      row,
      template: `${conference}/${kind}/{${kind}Id}`,
    });
  return [
    write(connection, {
      name: "create_space",
      description:
        "Create a new Google Meet space (a fresh meeting link) owned by the user, optionally with access, moderation and auto-artifact settings. Returns its name, link and meeting code.",
      input: Schema.Struct(settingFields),
      output: SpaceRecord,
      destructive: false,
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const { config } = spaceConfig(args);
          const created = yield* client
            .json({
              method: "POST",
              path: "/spaces",
              template: "/spaces",
              body: Object.keys(config).length ? { config } : {},
            })
            .pipe(
              Effect.catch((failure) => {
                // Sent and not refused: the space may exist, with no name to read
                // back. Another create makes a second meeting link.
                const outcome = googleOutcomeOf(failure);
                return outcome?.dispatched === true && outcome.phase !== "refused" && outcome.phase !== "before-send"
                  ? googleFailureMessage(
                      connection,
                      failure,
                      (message) =>
                        `${message} create_space makes a new meeting link on every call, and Meet cannot list spaces: ask the user whether a new link appeared before creating another.`,
                    )
                  : Effect.fail(failure);
              }),
            );
          return project(created, SpaceRecord);
        }).pipe(knownFailures),
    }),
    read(connection, {
      name: "get_space",
      description:
        "Get one Google Meet space by name, meeting code or meet.google.com link: join link, dial-in, settings, and its active conference record if a meeting is under way.",
      input: Schema.Struct({ space: spaceRef }),
      output: SpaceRecord,
      fields: true,
      run: (args: JsonRecord) =>
        Effect.map(
          client.json({
            method: "GET",
            path: `/spaces/${encodeURIComponent(spaceId(args["space"]))}`,
            template: "/spaces/{spacesId}",
          }),
          (answer) => project(answer, SpaceRecord),
        ),
    }),
    write(connection, {
      name: "update_space",
      description:
        "Change a Google Meet space's settings: access type, entry points, moderation and its restrictions, attendance report, and auto recording, transcripts or smart notes. Only the settings named change.",
      input: Schema.Struct({ space: spaceName, ...settingFields }),
      output: SpaceRecord,
      destructive: true,
      idempotent: true,
      check: (args: JsonRecord, problems: ArgumentProblems) => {
        if (!SETTING_KEYS.some((key) => args[key] !== undefined))
          problems.add("", `at least one setting: ${SETTING_KEYS.join(", ")}`);
      },
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const { config, mask } = spaceConfig(args);
          const updated = yield* client.json({
            method: "PATCH",
            path: pathOf(args["space"]),
            template: "/spaces/{spacesId}",
            query: { updateMask: mask.join(",") },
            body: { config },
          });
          return project(updated, SpaceRecord);
        }).pipe(knownFailures),
    }),
    write(connection, {
      name: "end_active_conference",
      description:
        "End the meeting under way in a Google Meet space this connection's app created, removing everyone from the call. The space and its link remain.",
      input: Schema.Struct({ space: spaceName }),
      output: Schema.Struct({ space: Schema.String, ended: Schema.Boolean }),
      destructive: true,
      run: (args: JsonRecord) =>
        Effect.map(
          client.json({
            method: "POST",
            path: `${pathOf(args["space"])}:endActiveConference`,
            template: "/spaces/{spacesId}:endActiveConference",
            body: {},
          }),
          () => ({ space: args["space"] as string, ended: true }),
        ),
    }),
    list(connection, client, {
      name: "list_conference_records",
      description:
        "List Google Meet conferences (one per meeting held in a space) the user can see, newest first, filtered by space or meeting code, start time, or still under way.",
      filters: {
        space: Schema.optionalKey(spaceRef),
        startedAfter: Schema.optionalKey(instant("Inclusive UTC start lower bound, e.g. 2026-10-01T00:00:00Z.")),
        startedBefore: Schema.optionalKey(instant("Exclusive UTC start upper bound, e.g. 2026-10-02T00:00:00Z.")),
        activeOnly: Schema.optionalKey(activeOnly),
      },
      row: ConferenceRecordRow,
      key: "conferenceRecords",
      limit: { default: 25, max: 100, noun: "conference records" },
      request: (args) => {
        const terms: string[] = [];
        if (args.space !== undefined) {
          const id = spaceId(args.space);
          terms.push(
            !args.space.startsWith("spaces/") && MEETING_CODE.test(id)
              ? `space.meeting_code = "${id}"`
              : `space.name = "spaces/${id}"`,
          );
        }
        if (args.startedAfter !== undefined) terms.push(`start_time >= "${args.startedAfter}"`);
        if (args.startedBefore !== undefined) terms.push(`start_time < "${args.startedBefore}"`);
        if (args.activeOnly === true) terms.push("end_time IS NULL");
        return {
          path: "/conferenceRecords",
          template: "/conferenceRecords",
          ...(terms.length ? { filter: terms.join(" AND ") } : {}),
        };
      },
    }),
    getOne(connection, client, {
      name: "get_conference_record",
      description:
        "Get one Google Meet conference record: its space, start and end time, and when Google deletes the record.",
      argument: "conferenceRecord",
      input: conferenceRecord,
      row: ConferenceRecordRow,
      template: conference,
    }),
    list(connection, client, {
      name: "list_participants",
      description:
        "List who attended a Meet conference, latest join first: signed-in users with their People user id, anonymous and phone attendees, and first join and last leave times.",
      filters: { conferenceRecord, activeOnly: Schema.optionalKey(activeOnly) },
      row: ParticipantRow,
      key: "participants",
      limit: { default: 100, max: 250, noun: "participants" },
      request: (args) => ({
        path: `${pathOf(args.conferenceRecord)}/participants`,
        template: `${conference}/participants`,
        ...(args.activeOnly === true ? { filter: "latest_end_time IS NULL" } : {}),
      }),
    }),
    getOne(connection, client, {
      name: "get_participant",
      description: "Get one Meet conference participant: who they are and their first join and last leave times.",
      argument: "participant",
      input: participantName,
      row: ParticipantRow,
      template: participant,
    }),
    list(connection, client, {
      name: "list_participant_sessions",
      description:
        "List one participant's join-to-leave sessions in a Meet conference, latest first; each rejoin or device is its own session.",
      filters: { participant: participantName, activeOnly: Schema.optionalKey(activeOnly) },
      row: SessionRow,
      key: "participantSessions",
      limit: { default: 100, max: 250, noun: "sessions" },
      request: (args) => ({
        path: `${pathOf(args.participant)}/participantSessions`,
        template: `${participant}/participantSessions`,
        ...(args.activeOnly === true ? { filter: "end_time IS NULL" } : {}),
      }),
    }),
    getOne(connection, client, {
      name: "get_participant_session",
      description: "Get one Meet participant session: its join and leave times.",
      argument: "session",
      input: name(
        "Session name conferenceRecords/<id>/participants/<id>/participantSessions/<id> from list_participant_sessions.",
        `^conferenceRecords/${ID}/participants/${ID}/participantSessions/${ID}$`,
      ),
      row: SessionRow,
      template: `${participant}/participantSessions/{participantSessionsId}`,
    }),
    artifacts("recordings", "recordings", RecordingRow),
    artifact("recordings", "recording", RecordingRow),
    artifacts("transcripts", "transcripts", DocsRow),
    artifact("transcripts", "transcript", DocsRow),
    list(connection, client, {
      name: "list_transcript_entries",
      description:
        "Read a Meet transcript's spoken entries in order: speaker participant, text, language and times. Long entries are cut; get_transcript_entry reads one whole.",
      filters: { transcript: transcriptName },
      row: EntryRow,
      key: "transcriptEntries",
      limit: { default: 25, max: 50, noun: "entries" },
      request: (args) => ({ path: `${pathOf(args.transcript)}/entries`, template: `${transcript}/entries` }),
      fit: fitEntry,
      truncatedPath: "items[].text",
    }),
    getOne(connection, client, {
      name: "get_transcript_entry",
      description: "Get one Meet transcript entry whole: speaker participant, text, language and times.",
      argument: "entry",
      input: name(
        "Entry name conferenceRecords/<id>/transcripts/<id>/entries/<id> from list_transcript_entries.",
        `^conferenceRecords/${ID}/transcripts/${ID}/entries/${ID}$`,
      ),
      row: EntryRow,
      template: `${transcript}/entries/{entriesId}`,
    }),
    artifacts("smartNotes", "smart notes", DocsRow),
    artifact("smartNotes", "smart_note", DocsRow),
  ];
}
