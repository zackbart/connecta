// Forms projections and revision-checked workflows on the standard provider kit.
import { Effect, Option, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import type { Connection } from "../../http/vendor.js";
import type { ConnectorContext } from "../../types.js";
import { clampText, jsonBytes, RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import { googleClient, googleFailureMessage, googleOutcomeOf } from "../_shared/google/kit.js";
import { encodeForAgent, redactBeforeCut, redactSentSecrets } from "../../sent-secrets.js";
import { Integer, isMaxChars, isMinChars } from "../../http/json-schema.js";
import { boundCursor, StandardPage } from "../../http/paging.js";
import { read, write } from "../../http/tools.js";
import { fieldsInput, fieldsProblem, selectFields } from "../../http/fields.js";
import { Refusal } from "../../http/errors.js";
import { Operation } from "../../runtime/call.js";
import { formsIndex, FORMS_REQUEST_KINDS } from "./lib/hatch.js";
import { googleBatchGuard } from "../_shared/google/hatch.js";

/** Google's own response page maximum is 5,000; a page an agent reads is not. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
/** A listed answer is cut here; get_response returns it whole. */
const LIST_ANSWER_CHARS = 2_000;
/** A form or item title or description is cut here in get_form's projection. */
const DESCRIPTION_CHARS = 2_000;
/** ...and bounded here in bytes, so escaped control characters cannot grow it. */
const DESCRIPTION_BYTES = 8 * 1024;
/** Options shown per choice question; a long dropdown says how many it hid. */
const MAX_OPTIONS = 100;
/** An option or grid row is cut here; forms_api_read reads it whole. */
const MAX_LABEL_CHARS = 300;
const MAX_LABEL_BYTES = 1024;
/** One answer value in get_response, before it would crowd out the rest. */
const MAX_ANSWER_CHARS = 50_000;
/** Question ids one get_response call may name. */
const MAX_QUESTION_IDS = 100;
/** Requests in one batch_update_form call. */
const MAX_REQUESTS = 100;
/**
 * Room a filling page keeps for its own fields and its cursor. Every result
 * stays inside the shared RESULT_BUDGET_BYTES (`./google/result-size.ts`), so
 * it crosses execute_code's host bridge and a direct call alike; a page ends
 * early, with a cursor, rather than grow past it, and the complete result,
 * cursor included, is measured before it is returned.
 */
const PAGE_RESERVE_BYTES = 4 * 1024;

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Cut text at `max` characters and say so in the text itself. Every secret the request sent
 * is replaced first: a cut through an echo leaves a fragment no later redaction finds. */
function capped(ctx: ConnectorContext, whole: string | undefined, max: number, remedy: string): string | undefined {
  if (whole === undefined || whole.length <= max) return whole;
  const value = redactBeforeCut(ctx, whole);
  if (value.length <= max) return value;
  // Never split a surrogate pair: a lone high surrogate before the marker
  // would make the text ill-formed.
  let cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}\n[… ${value.length - cut.length} more characters truncated; ${remedy}]`;
}

/**
 * Text cut at `chars` characters, then held to `bytes` of JSON — quotes and
 * escapes counted — so a run of control characters cannot outgrow its place.
 */
function bounded(ctx: ConnectorContext, value: string | undefined, chars: number, bytes: number): string | undefined {
  const cut = capped(ctx, value, chars, "use forms_api_read to read it");
  if (cut === undefined || jsonBytes(cut) <= bytes) return cut;
  return clampText(
    ctx,
    value!,
    bytes,
    (dropped) => `\n[… ${dropped} more characters truncated; use forms_api_read to read it]`,
  );
}

function editUrl(formId: string): string {
  return `https://docs.google.com/forms/d/${encodeURIComponent(formId)}/edit`;
}

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** What a cursor is bound to: its tool and every argument that decides its pages. */
async function digestOf(bound: readonly unknown[]): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(bound))));
  return base64Url(hash.subarray(0, 16));
}

/**
 * A cursor of connecta's claims. An agent decodes it and no later pass reads
 * through its encoding, so Google's text enters only redacted: a page token
 * it must send back, redacted ({@link redactSentSecrets}); a value it only
 * compares, by {@link claimOf}.
 */
function encodeCursor(
  ctx: ConnectorContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  cursor: JsonRecord,
) {
  return boundCursor.encode(tool, args, JSON.stringify(cursor), (json) =>
    encodeForAgent(ctx, json, { url: true, claims: true }),
  );
}

/** A downstream value a cursor only compares: itself, or its digest when it holds a sent value. */
async function claimOf(ctx: ConnectorContext, value: string): Promise<string> {
  return redactSentSecrets(ctx, value) === value ? value : `#${await digestOf(["claim", value])}`;
}

/**
 * A cursor this tool issued for these same arguments, or a refusal: one
 * carried to another form, filter, or tool would page through something else.
 */
function decodeCursor(
  value: string,
  digest: string,
  keys: readonly string[],
  valid: (cursor: JsonRecord) => boolean,
  again: string,
): JsonRecord {
  let cursor: JsonRecord;
  try {
    cursor = asRecord(JSON.parse(value));
  } catch {
    cursor = {};
  }
  const shaped = Object.keys(cursor).length === keys.length && keys.every((key) => key in cursor);
  if (!shaped || cursor["d"] !== digest || !valid(cursor)) {
    throw new ConnectorCallError(
      "invalid_args",
      `cursor is not one this tool returned for these arguments. Pass page.nextCursor back unchanged, ${again}.`,
    );
  }
  return cursor;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// --- Reading forms ----------------------------------------------------------------

/** Google's question kinds, named as an agent would say them. */
type QuestionType =
  | "short_text"
  | "paragraph"
  | "radio"
  | "checkbox"
  | "drop_down"
  | "scale"
  | "date"
  | "time"
  | "rating"
  | "file_upload"
  | "grid_row"
  | "unknown";

const CHOICE_TYPES: Readonly<Record<string, QuestionType>> = {
  RADIO: "radio",
  CHECKBOX: "checkbox",
  DROP_DOWN: "drop_down",
};

function choiceOptions(ctx: ConnectorContext, choice: JsonRecord): JsonRecord {
  const all = asArray(choice["options"]).map(asRecord);
  const hasOther = all.some((option) => option["isOther"] === true);
  const values = all
    .filter((option) => option["isOther"] !== true)
    .map((option) => bounded(ctx, String(option["value"] ?? ""), MAX_LABEL_CHARS, MAX_LABEL_BYTES) ?? "");
  return compact({
    options: values.slice(0, MAX_OPTIONS),
    moreOptions: values.length > MAX_OPTIONS ? values.length - MAX_OPTIONS : undefined,
    hasOther: hasOther || undefined,
  });
}

/** One question's id, type, and the shape of what it accepts. */
function projectQuestion(ctx: ConnectorContext, value: unknown, rowTitle?: string): JsonRecord {
  const question = asRecord(value);
  const grading = asRecord(question["grading"]);
  const base = {
    questionId: text(question["questionId"]),
    rowTitle,
    required: question["required"] === true,
    points: integer(grading["pointValue"]),
  };
  if (question["choiceQuestion"]) {
    const choice = asRecord(question["choiceQuestion"]);
    return compact({ ...base, type: CHOICE_TYPES[String(choice["type"])] ?? "unknown", ...choiceOptions(ctx, choice) });
  }
  if (question["textQuestion"]) {
    return compact({
      ...base,
      type: asRecord(question["textQuestion"])["paragraph"] === true ? "paragraph" : "short_text",
    });
  }
  if (question["scaleQuestion"]) {
    const scale = asRecord(question["scaleQuestion"]);
    return compact({
      ...base,
      type: "scale",
      scale: compact({
        low: integer(scale["low"]),
        high: integer(scale["high"]),
        lowLabel: text(scale["lowLabel"]),
        highLabel: text(scale["highLabel"]),
      }),
    });
  }
  if (question["dateQuestion"]) {
    const date = asRecord(question["dateQuestion"]);
    return compact({
      ...base,
      type: "date",
      includesYear: date["includeYear"] === true,
      includesTime: date["includeTime"] === true,
    });
  }
  if (question["timeQuestion"]) {
    return compact({ ...base, type: "time", duration: asRecord(question["timeQuestion"])["duration"] === true });
  }
  if (question["ratingQuestion"]) {
    const rating = asRecord(question["ratingQuestion"]);
    return compact({ ...base, type: "rating", scale: compact({ low: 1, high: integer(rating["ratingScaleLevel"]) }) });
  }
  if (question["fileUploadQuestion"]) return compact({ ...base, type: "file_upload" });
  if (question["rowQuestion"]) return compact({ ...base, type: "grid_row" });
  return compact({ ...base, type: "unknown" });
}

type ItemKind = "question" | "question_group" | "page_break" | "text" | "image" | "video" | "unknown";

/**
 * One item, with every question it asks under `questions`: one for a question
 * item, one per row for a grid, none for a section break or media. Answers are
 * keyed by question id, so this is the map a response is read through.
 */
function projectItem(ctx: ConnectorContext, value: unknown): JsonRecord {
  const item = asRecord(value);
  const base = {
    itemId: text(item["itemId"]),
    title: bounded(ctx, text(item["title"]), DESCRIPTION_CHARS, DESCRIPTION_BYTES),
    description: bounded(ctx, text(item["description"]), DESCRIPTION_CHARS, DESCRIPTION_BYTES),
  };
  if (item["questionItem"]) {
    return compact({
      ...base,
      kind: "question" satisfies ItemKind,
      questions: [projectQuestion(ctx, asRecord(item["questionItem"])["question"])],
    });
  }
  if (item["questionGroupItem"]) {
    const group = asRecord(item["questionGroupItem"]);
    const grid = asRecord(group["grid"]);
    const columns = asRecord(grid["columns"]);
    return compact({
      ...base,
      kind: "question_group" satisfies ItemKind,
      // A grid's rows share its columns: the choices are stated once, here.
      gridType: group["grid"] ? (CHOICE_TYPES[String(columns["type"])] ?? "unknown") : undefined,
      ...(group["grid"] ? choiceOptions(ctx, columns) : {}),
      questions: asArray(group["questions"]).map((question) =>
        projectQuestion(
          ctx,
          question,
          bounded(ctx, text(asRecord(asRecord(question)["rowQuestion"])["title"]), MAX_LABEL_CHARS, MAX_LABEL_BYTES),
        ),
      ),
    });
  }
  const kind: ItemKind = item["pageBreakItem"]
    ? "page_break"
    : item["textItem"]
      ? "text"
      : item["imageItem"]
        ? "image"
        : item["videoItem"]
          ? "video"
          : "unknown";
  return compact({ ...base, kind });
}

function projectForm(ctx: ConnectorContext, value: unknown): JsonRecord {
  const form = asRecord(value);
  const info = asRecord(form["info"]);
  const settings = asRecord(form["settings"]);
  const publish = asRecord(asRecord(form["publishSettings"])["publishState"]);
  const formId = text(form["formId"]);
  const items = asArray(form["items"]).map((item) => projectItem(ctx, item));
  return compact({
    formId,
    title: bounded(ctx, text(info["title"]), DESCRIPTION_CHARS, DESCRIPTION_BYTES),
    documentTitle: bounded(ctx, text(info["documentTitle"]), DESCRIPTION_CHARS, DESCRIPTION_BYTES),
    description: bounded(ctx, text(info["description"]), DESCRIPTION_CHARS, DESCRIPTION_BYTES),
    revisionId: text(form["revisionId"]),
    responderUri: text(form["responderUri"]),
    editUrl: formId ? editUrl(formId) : undefined,
    linkedSheetId: text(form["linkedSheetId"]),
    isQuiz: asRecord(settings["quizSettings"])["isQuiz"] === true,
    emailCollection: text(settings["emailCollectionType"]),
    // Absent on a legacy form, which has no publish settings at all.
    published: form["publishSettings"] ? publish["isPublished"] === true : undefined,
    acceptingResponses: form["publishSettings"] ? publish["isAcceptingResponses"] === true : undefined,
    itemCount: items.length,
    questionCount: items.reduce((count, item) => count + asArray(item["questions"]).length, 0),
    items,
  });
}

/**
 * An item cut to `budget` bytes. Its own text and every option and label are
 * already bounded (an item without questions stays under ~120 KiB), so only a
 * grid's rows can outgrow a page; the rows that fit are kept and the rest
 * counted in `moreQuestions`, and the page's cursor continues inside this
 * item from the first row it left out. The caller still measures what it
 * returns.
 */
function fitItem(item: JsonRecord, budget: number): JsonRecord {
  if (jsonBytes(item) <= budget) return item;
  const questions = asArray(item["questions"]);
  const kept: unknown[] = [];
  let used = jsonBytes({ ...item, questions: [], moreQuestions: questions.length });
  for (const question of questions) {
    const size = jsonBytes(question) + 1;
    if (used + size > budget) break;
    kept.push(question);
    used += size;
  }
  return { ...item, questions: kept, moreQuestions: questions.length - kept.length };
}

/**
 * An item's questions from `from` on, for a page that continues inside it.
 * Its description and options went out with its first part; the continuation
 * carries what places the rows — its id, kind, and title — and where they
 * start, in `questionsFrom`.
 */
function continuedItem(item: JsonRecord, from: number): JsonRecord {
  if (from === 0) return item;
  return compact({
    itemId: item["itemId"],
    kind: item["kind"],
    title: item["title"],
    questionsFrom: from,
    questions: asArray(item["questions"]).slice(from),
  });
}

// --- Reading responses ------------------------------------------------------------

interface QuestionLabel {
  title: string | undefined;
  order: number;
}

/**
 * Every question id in the form, labeled the way a person reads it — the
 * item's title, and the row's for a grid — in the form's own order.
 */
function questionLabels(ctx: ConnectorContext, form: unknown): Map<string, QuestionLabel> {
  const labels = new Map<string, QuestionLabel>();
  for (const value of asArray(asRecord(form)["items"])) {
    const item = projectItem(ctx, value);
    for (const question of asArray(item["questions"]).map(asRecord)) {
      const id = text(question["questionId"]);
      if (!id) continue;
      const title = question["rowTitle"] ? `${item["title"] ?? ""} [${question["rowTitle"]}]`.trim() : item["title"];
      labels.set(id, { title, order: labels.size });
    }
  }
  return labels;
}

/**
 * A grader's feedback on one answer: its text, and the links or videos it
 * points to, each as the address a person opens and the label they were shown.
 */
function projectFeedback(
  ctx: ConnectorContext,
  value: unknown,
  maxChars: number | undefined,
  remedy: string,
): JsonRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const feedback = asRecord(value);
  const links = asArray(feedback["material"]).map((entry) => {
    const material = asRecord(entry);
    const link = asRecord(material["link"]);
    const video = asRecord(material["video"]);
    return compact({
      uri: text(link["uri"]) ?? text(video["youtubeUri"]),
      displayText: text(link["displayText"]) ?? text(video["displayText"]),
      video: material["video"] ? true : undefined,
    });
  });
  const said = text(feedback["text"]);
  return compact({
    text: maxChars === undefined ? said : capped(ctx, said, maxChars, remedy),
    links: links.length > 0 ? links : undefined,
  });
}

function projectResponse(
  ctx: ConnectorContext,
  value: unknown,
  labels: Map<string, QuestionLabel>,
  maxChars: number | undefined,
  remedy: string,
): JsonRecord {
  const response = asRecord(value);
  const answers = Object.entries(asRecord(response["answers"])).map(([key, raw]) => {
    const answer = asRecord(raw);
    const questionId = text(answer["questionId"]) ?? key;
    const grade = asRecord(answer["grade"]);
    const values = asArray(asRecord(answer["textAnswers"])["answers"]).map((entry) => {
      const value = String(asRecord(entry)["value"] ?? "");
      return maxChars === undefined ? value : capped(ctx, value, maxChars, remedy)!;
    });
    const files = asArray(asRecord(answer["fileUploadAnswers"])["answers"]).map((entry) => {
      const file = asRecord(entry);
      return compact({
        fileId: text(file["fileId"]),
        fileName: text(file["fileName"]),
        mimeType: text(file["mimeType"]),
      });
    });
    return compact({
      questionId,
      // Undefined for a question deleted since this response was submitted.
      title: labels.get(questionId)?.title,
      values: files.length > 0 && values.length === 0 ? undefined : values,
      files: files.length > 0 ? files : undefined,
      score: typeof grade["score"] === "number" ? grade["score"] : undefined,
      correct: typeof grade["correct"] === "boolean" ? grade["correct"] : undefined,
      feedback: projectFeedback(ctx, grade["feedback"], maxChars, remedy),
    });
  });
  // The form's order, then anything the form no longer asks.
  const rank = (id: string) => labels.get(id)?.order ?? Number.MAX_SAFE_INTEGER;
  answers.sort((a, b) => rank(a.questionId) - rank(b.questionId));
  return compact({
    responseId: text(response["responseId"]),
    createTime: text(response["createTime"]),
    lastSubmittedTime: text(response["lastSubmittedTime"]),
    respondentEmail: text(response["respondentEmail"]),
    totalScore: typeof response["totalScore"] === "number" ? response["totalScore"] : undefined,
    answers,
  });
}

/**
 * A response projected inside `budget` bytes: answers cut at each of `caps`
 * in turn until it fits, and if even the last does not, answers left out from
 * the end and named in `omittedQuestionIds`, for get_response to read by id.
 */
function fitResponse(
  ctx: ConnectorContext,
  value: unknown,
  labels: Map<string, QuestionLabel>,
  caps: readonly (number | undefined)[],
  remedy: string,
  budget: number,
): JsonRecord {
  let projected: JsonRecord = {};
  for (const cap of caps) {
    projected = projectResponse(ctx, value, labels, cap, remedy);
    if (jsonBytes(projected) <= budget) return projected;
  }
  const answers = asArray(projected["answers"]).map(asRecord);
  const kept: JsonRecord[] = [];
  let used = jsonBytes({
    ...projected,
    answers: [],
    omittedQuestionIds: answers.map((answer) => answer["questionId"]),
  });
  for (const answer of answers) {
    const size = jsonBytes(answer) + 1;
    if (used + size > budget) break;
    kept.push(answer);
    used += size;
  }
  return {
    ...projected,
    answers: kept,
    omittedQuestionIds: answers.slice(kept.length).map((answer) => answer["questionId"]),
  };
}

// --- Writing ----------------------------------------------------------------------

/** What a batch reply says it made: the new item and its question ids. */
function projectReplies(value: unknown): JsonRecord[] {
  return asArray(value).map((entry) => {
    const created = asRecord(asRecord(entry)["createItem"]);
    return asRecord(entry)["createItem"]
      ? compact({
          createdItemId: text(created["itemId"]),
          createdQuestionIds: asArray(created["questionId"]).filter((id): id is string => typeof id === "string"),
        })
      : {};
  });
}

/**
 * A batch's reply, inside one result. The write has already applied by the
 * time this runs, so nothing here may read as failure or as nothing changed:
 * a reply too large to return whole — a grid created with thousands of rows
 * names every row's question id — drops the question ids first and keeps each
 * created item's id, and if even that cannot fit, keeps only the counts.
 * Either way `truncated` and `note` say the batch applied and where to read
 * what was left out.
 */
function projectBatch(formId: string, value: unknown): JsonRecord {
  const result = asRecord(value);
  const revisionId = text(asRecord(result["writeControl"])["requiredRevisionId"]);
  const replies = projectReplies(result["replies"]);
  const whole = compact({ formId, revisionId, replies });
  if (jsonBytes(whole) <= RESULT_BUDGET_BYTES) return whole;
  const note =
    "The batch applied. Its reply was too large to return whole; read the created items' question ids with get_form, following page.nextCursor to the last page.";
  const idsOnly = compact({
    formId,
    revisionId,
    replies: replies.map((reply) => compact({ createdItemId: reply["createdItemId"] })),
    truncated: ["replies[].createdQuestionIds"],
    note,
  });
  if (jsonBytes(idsOnly) <= RESULT_BUDGET_BYTES) return idsOnly;
  return compact({
    formId,
    revisionId: revisionId && jsonBytes(revisionId) <= 1024 ? revisionId : undefined,
    replies: [],
    replyCount: replies.length,
    createdItemCount: replies.filter((reply) => reply["createdItemId"] !== undefined).length,
    truncated: ["replies[]", ...(revisionId && jsonBytes(revisionId) > 1024 ? ["revisionId"] : [])],
    note: revisionId && jsonBytes(revisionId) <= 1024 ? note : `${note} Read its revisionId there too.`,
  });
}

// --- Effect schemas: catalog and runtime decoding share these declarations. ---
const pattern = (source: string) =>
  Schema.makeFilter((value: string) => new RegExp(source).test(value), { toJsonSchema: () => ({ pattern: source }) });
const string = (description: string, max = 256) =>
  Schema.String.check(isMinChars(1), isMaxChars(max)).annotate({ description });
const id = (description: string) => string(description).check(pattern("^[A-Za-z0-9_-]+$"));
const formId = id("Form id from its /forms/d/<formId>/edit URL or Drive; not the /forms/d/e/ responder link.");
const revision = string("Current revisionId from a read or preceding edit; re-read and rebuild after conflict.").check(
  pattern("^\\S+$"),
);
const cursor = Schema.optionalKey(string("Opaque page.nextCursor from this same tool and arguments.", 16384));
const optional = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Schema.optionalKey(value)])));
const Truncated = Schema.Array(Schema.String);
const File = optional({ fileId: Schema.String, fileName: Schema.String, mimeType: Schema.String });
const Feedback = optional({
  text: Schema.String,
  links: Schema.Array(optional({ uri: Schema.String, displayText: Schema.String, video: Schema.Boolean })),
});
const Answer = optional({
  questionId: Schema.String,
  title: Schema.String,
  values: Schema.Array(Schema.String),
  files: Schema.Array(File),
  score: Schema.Number,
  correct: Schema.Boolean,
  feedback: Feedback,
});
const ResponseRecord = optional({
  responseId: Schema.String,
  createTime: Schema.String,
  lastSubmittedTime: Schema.String,
  respondentEmail: Schema.String,
  totalScore: Schema.Number,
  omittedQuestionIds: Schema.Array(Schema.String),
  answers: Schema.Array(Answer),
  truncated: Truncated,
});
const choice = { options: Schema.Array(Schema.String), hasOther: Schema.Boolean };
const Question = optional({
  questionId: Schema.String,
  type: Schema.String,
  rowTitle: Schema.String,
  required: Schema.Boolean,
  points: Integer,
  ...choice,
  scale: optional({ low: Integer, high: Integer, lowLabel: Schema.String, highLabel: Schema.String }),
  includesYear: Schema.Boolean,
  includesTime: Schema.Boolean,
  duration: Schema.Boolean,
});
const Item = optional({
  itemId: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  description: Schema.String,
  gridType: Schema.String,
  ...choice,
  questions: Schema.Array(Question),
  questionsFrom: Integer,
});
const FormRecord = optional({
  formId: Schema.String,
  title: Schema.String,
  documentTitle: Schema.String,
  description: Schema.String,
  revisionId: Schema.String,
  responderUri: Schema.String,
  editUrl: Schema.String,
  linkedSheetId: Schema.String,
  isQuiz: Schema.Boolean,
  emailCollection: Schema.String,
  published: Schema.Boolean,
  acceptingResponses: Schema.Boolean,
  itemCount: Integer,
  questionCount: Integer,
  page: StandardPage,
  items: Schema.Array(Item),
  truncated: Truncated,
});
const BatchRecord = optional({
  formId: Schema.String,
  revisionId: Schema.String,
  replies: Schema.Array(optional({ createdItemId: Schema.String, createdQuestionIds: Schema.Array(Schema.String) })),
  truncated: Truncated,
  note: Schema.String,
  replyCount: Integer,
  createdItemCount: Integer,
});
const contextOf = Effect.gen(function* () {
  const operation = yield* Effect.serviceOption(Operation);
  if (Option.isNone(operation) || !operation.value) return yield* Effect.die(new Error("Missing Forms call context."));
  return operation.value;
});
const knownFailures = Effect.catchDefect((error: unknown) =>
  error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
);

/** Convert internal continuation counts and text markers into S3 paths. */
function standardResult(value: JsonRecord): JsonRecord {
  const truncated = new Set<string>(Array.isArray(value["truncated"]) ? value["truncated"] : []);
  const visit = (entry: unknown, path: string): unknown => {
    if (typeof entry === "string") {
      if (/\[… .*truncated;/.test(entry)) truncated.add(path);
      return entry;
    }
    if (Array.isArray(entry)) return entry.map((item) => visit(item, `${path}[]`));
    if (!entry || typeof entry !== "object") return entry;
    const out: JsonRecord = {};
    for (const [key, child] of Object.entries(entry)) {
      if (key === "truncated") continue;
      if (key === "moreOptions" || key === "moreQuestions") {
        if (child) truncated.add(`${path ? `${path}.` : ""}${key === "moreOptions" ? "options" : "questions"}[]`);
        continue;
      }
      if (key === "omittedQuestionIds" && Array.isArray(child) && child.length)
        truncated.add(`${path ? `${path}.` : ""}answers[]`);
      out[key] = visit(child, path ? `${path}.${key}` : key);
    }
    return out;
  };
  const result = visit(value, "") as JsonRecord;
  return { ...result, ...(truncated.size ? { truncated: [...truncated] } : {}) };
}

export function formsTools({ connection }: { connection: Connection }): ApiTool[] {
  const client = googleClient(connection, formsIndex);
  const formPath = (formId: string) => `/forms/${encodeURIComponent(formId)}`;
  const readForm = (formId: string, step?: string) =>
    client.json({ method: "GET", path: formPath(formId), template: "/forms/{formId}" }, step ? { step } : undefined);
  const pairedReads = { form: "once", answers: "once" } as const;
  const batch = (formId: string, requests: readonly unknown[], revisionId: string | undefined) =>
    Effect.gen(function* () {
      const body = compact({ requests, writeControl: revisionId ? { requiredRevisionId: revisionId } : undefined });
      const problem = googleBatchGuard(body, { kinds: FORMS_REQUEST_KINDS, revision: revisionId !== undefined });
      if (problem) return yield* Effect.fail(new Refusal({ error: new ConnectorCallError("invalid_args", problem) }));
      const reply = yield* client.json(
        { method: "POST", path: `${formPath(formId)}:batchUpdate`, template: "/forms/{formId}:batchUpdate", body },
        { revisionGuarded: revisionId !== undefined },
      );
      return projectBatch(formId, reply);
    });
  return [
    read(connection, {
      name: "get_form",
      description:
        "Get one Google Form: title, description, quiz and publish state, revisionId, and its items with question ids, types, and options, paged when large. Never lists forms.",
      input: Schema.Struct({
        formId,
        cursor,
        fields: Schema.optionalKey(fieldsInput("Dot paths to keep in the form; page and cut metadata is preserved.")),
      }),
      output: FormRecord,
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const problem = fieldsProblem(args.fields, new Set(Object.keys(FormRecord.fields)), "the form");
          if (problem) return yield* Effect.fail(new Refusal({ error: problem }));
          const formId: string = args["formId"];
          const form = yield* readForm(formId);
          const { items, ...header } = projectForm(ctx, form);
          const all = asArray(items).map(asRecord);
          const revision = yield* Effect.promise(() => claimOf(ctx, text(asRecord(form)["revisionId"]) ?? ""));
          const digest = yield* Effect.promise(() => digestOf(["get_form", formId]));
          // A cursor names an item and, inside a grid too large for one page,
          // the first of its questions not yet returned, so every question id
          // is reachable by paging, however many rows one grid has.
          let start = 0;
          let from = 0;
          if (typeof args["cursor"] === "string") {
            const cursor = decodeCursor(
              yield* boundCursor.decode("get_form", { formId }, args["cursor"]),
              digest,
              ["d", "i", "q", "r"],
              (c) => isIndex(c["i"]) && isIndex(c["q"]) && typeof c["r"] === "string",
              "with the same formId",
            );
            // Items are addressed by index and rows by position, so a page of a
            // changed form would skip or repeat them without saying so.
            const at = all[cursor["i"]];
            if (
              cursor["r"] !== revision ||
              cursor["i"] > all.length ||
              (cursor["q"] > 0 && (at === undefined || cursor["q"] >= asArray(at["questions"]).length))
            ) {
              throw new ConnectorCallError(
                "conflict",
                "The form changed after the page this cursor continues. Read get_form again from the start, without cursor.",
              );
            }
            start = cursor["i"];
            from = cursor["q"];
          }
          const piece = (index: number) => (index === start ? continuedItem(all[index]!, from) : all[index]!);
          const kept: JsonRecord[] = [];
          let used = jsonBytes({ ...header, items: [] }) + PAGE_RESERVE_BYTES;
          for (let index = start; index < all.length; index += 1) {
            let item = piece(index);
            let size = jsonBytes(item) + 1;
            if (used + size > RESULT_BUDGET_BYTES) {
              if (kept.length > 0) break;
              item = fitItem(item, RESULT_BUDGET_BYTES - used);
              size = jsonBytes(item) + 1;
            }
            kept.push(item);
            used += size;
            // A grid cut short ends the page: the cursor continues inside it.
            if (item["moreQuestions"]) break;
          }
          const build = () =>
            Effect.gen(function* () {
              const lastIndex = start + kept.length - 1;
              const last = kept[kept.length - 1];
              let next: JsonRecord | undefined;
              if (last?.["moreQuestions"]) {
                const before = lastIndex === start ? from : 0;
                next = { d: digest, i: lastIndex, q: before + asArray(last["questions"]).length, r: revision };
              } else if (lastIndex + 1 < all.length) {
                next = { d: digest, i: lastIndex + 1, q: 0, r: revision };
              }
              const nextCursor = next ? yield* encodeCursor(ctx, "get_form", { formId }, next) : undefined;
              return {
                ...header,
                page: { hasMore: nextCursor !== undefined, ...(nextCursor ? { nextCursor } : {}) },
                items: kept,
              };
            });
          // The estimate above reserved room; the complete result, cursor and
          // all, is what has to fit.
          let result = yield* build();
          while (jsonBytes(result) > RESULT_BUDGET_BYTES && kept.length > 1) {
            kept.pop();
            result = yield* build();
          }
          if (jsonBytes(result) > RESULT_BUDGET_BYTES && kept.length === 1) {
            // Measured with the longest cursor this page could carry.
            const room = RESULT_BUDGET_BYTES - jsonBytes({ ...result, items: [] }) - 64;
            kept[0] = fitItem(piece(start), room);
            result = yield* build();
          }
          // A page must move forward: a continued grid that cannot fit even one
          // row would hand back the cursor it was given.
          const first = kept[0];
          const stalled = first?.["moreQuestions"] !== undefined && asArray(first["questions"]).length === 0;
          if (jsonBytes(result) > RESULT_BUDGET_BYTES || stalled) {
            throw new ConnectorCallError(
              "connector_call_failed",
              `Item ${start} of this form cannot be projected inside one result (${RESULT_BUDGET_BYTES} bytes), even alone; open the form in Forms.`,
              { retryable: false },
            );
          }
          const safe = standardResult(result);
          return {
            ...(selectFields(safe, args.fields) as JsonRecord),
            page: result.page,
            ...(safe["truncated"] ? { truncated: safe["truncated"] } : {}),
          };
        }).pipe(knownFailures),
    }),
    write(connection, {
      name: "create_form",
      description:
        "Create an empty Google Form with a title in the user's Drive. Google sets only the title here: add questions and a description with batch_update_form.",
      input: Schema.Struct({
        title: string("Title responders see.", 1000),
        documentTitle: Schema.optionalKey(string("Drive file name; defaults to title.", 1000)),
        unpublished: Schema.optionalKey(
          Schema.Boolean.annotate({
            description:
              "Create without accepting responses; only the owner can publish it later. Omit for Google default publishing.",
          }),
        ),
      }),
      output: optional({
        formId: Schema.String,
        title: Schema.String,
        documentTitle: Schema.String,
        revisionId: Schema.String,
        responderUri: Schema.String,
        editUrl: Schema.String,
      }),
      destructive: false,
      run: (args) =>
        Effect.gen(function* () {
          const created = yield* client
            .json({
              method: "POST",
              path: "/forms",
              template: "/forms",
              query: { unpublished: args["unpublished"] === true ? true : undefined },
              body: { info: compact({ title: args["title"], documentTitle: args["documentTitle"] }) },
            })
            .pipe(
              Effect.catch((failure) => {
                // Sent and not refused — no answer, a 5xx or redirect after Google received
                // it, or a reply that broke: the form may exist, and there is no
                // form id to re-read. Another create would make a second one, so
                // say where to look first. The shared verdict (not retryable)
                // stands: a create, a batch, and an info update are each not safe
                // to send twice blind.
                // Any phase that is neither "never sent" nor "explicitly refused"
                // is uncertain, so a phase the shared layer adds later is too.
                const outcome = googleOutcomeOf(failure);
                return outcome?.dispatched === true && outcome.phase !== "refused" && outcome.phase !== "before-send"
                  ? googleFailureMessage(
                      connection,
                      failure,
                      (message) =>
                        `${message} create_form makes a new form on every call: look for "${args["documentTitle"] ?? args["title"]}" in the user's Drive, or ask them, before creating it again.`,
                    )
                  : Effect.fail(failure);
              }),
            );
          const form = asRecord(created);
          const formId = text(form["formId"]);
          const info = asRecord(form["info"]);
          return compact({
            formId,
            title: text(info["title"]),
            documentTitle: text(info["documentTitle"]),
            revisionId: text(form["revisionId"]),
            responderUri: text(form["responderUri"]),
            editUrl: formId ? editUrl(formId) : undefined,
          });
        }).pipe(knownFailures),
    }),
    read(connection, {
      name: "list_responses",
      description:
        "List a Google Form's submitted responses, each answer labeled with its question's title in form order. Long answers are cut; get_response reads one whole.",
      input: Schema.Struct({
        fields: Schema.optionalKey(fieldsInput("Dot paths to keep in each response item; only narrows safe data.")),
        formId,
        submittedAfter: Schema.optionalKey(
          Schema.String.check(pattern("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$")).annotate({
            description: "Exclusive submitted-after UTC instant, e.g. 2026-10-01T00:00:00Z.",
          }),
        ),
        limit: Schema.optionalKey(
          Integer.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })).annotate({
            description: "Maximum responses; default 25, at most 100.",
            default: 25,
          }),
        ),
        cursor,
      }),
      output: Schema.Struct({
        items: Schema.Array(ResponseRecord),
        page: StandardPage,
        truncated: Schema.optionalKey(Truncated),
      }),
      writeSteps: pairedReads,
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const problem = fieldsProblem(args.fields, new Set(Object.keys(ResponseRecord.fields)), "a response item");
          if (problem) return yield* Effect.fail(new Refusal({ error: problem }));
          const formId: string = args["formId"];
          const limit: number = args["limit"] ?? DEFAULT_PAGE_SIZE;
          const digest = yield* Effect.promise(() =>
            digestOf(["list_responses", formId, args["submittedAfter"] ?? null]),
          );
          // A cursor names Google's page (its token and size) and, when a page
          // ended early to stay inside its byte budget, the last response it
          // returned and a fingerprint of that Google page's ordered response
          // ids. The next call re-reads the page and continues strictly after
          // that response only if the page is exactly as it was: Google promises
          // neither a stable order nor a snapshot, so a reordered, grown, or
          // shrunk page could repeat, skip, or cycle, and is refused instead.
          // Moving to Google's next page needs none of this: its token is Google's.
          const resume =
            typeof args["cursor"] === "string"
              ? decodeCursor(
                  yield* boundCursor.decode(
                    "list_responses",
                    { formId, submittedAfter: args["submittedAfter"] },
                    args["cursor"],
                  ),
                  digest,
                  ["d", "t", "a", "h", "n"],
                  (c) =>
                    (c["t"] === null || typeof c["t"] === "string") &&
                    ((c["a"] === null && c["h"] === null) ||
                      (typeof c["a"] === "string" && c["a"] !== "" && typeof c["h"] === "string")) &&
                    isIndex(c["n"]) &&
                    c["n"] >= 1 &&
                    c["n"] <= MAX_PAGE_SIZE,
                  "with the same formId and submittedAfter",
                )
              : undefined;
          const token: string | null = resume?.["t"] ?? null;
          const size: number = resume?.["n"] ?? limit;
          const anchor: string | null = resume?.["a"] ?? null;
          const fingerprint: string | null = resume?.["h"] ?? null;
          // The form labels the answers. Both reads are one person's view, so
          // either failing fails the call rather than returning bare ids.
          const [form, listing] = yield* Effect.all(
            [
              readForm(formId, "form"),
              client.json(
                {
                  method: "GET",
                  path: `${formPath(formId)}/responses`,
                  template: "/forms/{formId}/responses",
                  query: {
                    filter: args["submittedAfter"] ? `timestamp > ${args["submittedAfter"]}` : undefined,
                    pageSize: size,
                    pageToken: token ?? undefined,
                  },
                },
                { step: "answers" },
              ),
            ],
            { concurrency: "unbounded" },
          );
          const labels = questionLabels(ctx, form);
          const page = asRecord(listing);
          const rows = asArray(page["responses"]);
          const idOf = (row: unknown) => text(asRecord(row)["responseId"]);
          const pageHash = yield* Effect.promise(() => digestOf(["page", ...rows.map((row) => idOf(row) ?? null)]));
          // Each response id as a cursor names it.
          const claims = yield* Effect.promise(() => Promise.all(rows.map((row) => claimOf(ctx, idOf(row) ?? ""))));
          let start = 0;
          if (anchor !== null) {
            const at = claims.findIndex((claim, index) => idOf(rows[index]) !== undefined && claim === anchor);
            if (fingerprint !== pageHash || at < 0) {
              throw new ConnectorCallError(
                "conflict",
                "Google's page of responses changed since this cursor was issued (reordered, or responses added or removed), so continuing could repeat or skip some. Start again without cursor, or pass the newest lastSubmittedTime already read as submittedAfter.",
              );
            }
            start = at + 1;
          }
          const remedy = "get_response reads it whole";
          const responses: JsonRecord[] = [];
          let used =
            jsonBytes({ formId, responses: [], page: { hasMore: true, nextCursor: null } }) + PAGE_RESERVE_BYTES;
          for (let index = start; index < rows.length; index += 1) {
            const room = RESULT_BUDGET_BYTES - used;
            let response = projectResponse(ctx, rows[index], labels, LIST_ANSWER_CHARS, remedy);
            if (jsonBytes(response) + 1 > room) {
              if (responses.length > 0) break;
              response = fitResponse(ctx, rows[index], labels, [LIST_ANSWER_CHARS, 200], remedy, room - 1);
            }
            responses.push(response);
            used += jsonBytes(response) + 1;
          }
          const rawToken = page["nextPageToken"];
          if (
            rawToken !== undefined &&
            (typeof rawToken !== "string" ||
              (rawToken &&
                (!rawToken.trim() ||
                  /^[a-z][a-z0-9+.-]*:/i.test(rawToken) ||
                  [...rawToken].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))))
          )
            throw new ConnectorCallError(
              "connector_call_failed",
              "Google returned malformed response paging metadata.",
            );
          const google = text(rawToken);
          const googleNext = google === undefined ? null : redactSentSecrets(ctx, google);
          if (googleNext && (googleNext !== google || googleNext.includes("[redacted]")))
            throw new ConnectorCallError(
              "connector_call_failed",
              "Google returned a withheld response page token; continuation is unavailable.",
            );
          const build = () =>
            Effect.gen(function* () {
              const last = start + responses.length - 1;
              // Rows left on Google's page: continue after the last one returned.
              // A page that ended on an anchor with nothing after it has no
              // response of its own to anchor on, and moves to Google's next page.
              let next: JsonRecord | undefined;
              if (start + responses.length < rows.length && responses.length > 0) {
                const after = idOf(rows[last]) === undefined ? undefined : claims[last];
                if (after === undefined) {
                  throw new ConnectorCallError(
                    "connector_call_failed",
                    "Google returned a response without an id, so this page cannot be continued safely.",
                    { retryable: false },
                  );
                }
                next = { d: digest, t: token, a: after, h: pageHash, n: size };
              } else if (googleNext) {
                next = { d: digest, t: googleNext, a: null, h: null, n: limit };
              }
              const nextCursor = next
                ? yield* encodeCursor(ctx, "list_responses", { formId, submittedAfter: args["submittedAfter"] }, next)
                : undefined;
              return {
                items: responses,
                page: { hasMore: nextCursor !== undefined, ...(nextCursor ? { nextCursor } : {}) },
              };
            });
          let result = yield* build();
          while (jsonBytes(result) > RESULT_BUDGET_BYTES && responses.length > 1) {
            responses.pop();
            result = yield* build();
          }
          if (jsonBytes(result) > RESULT_BUDGET_BYTES && responses.length === 1) {
            responses[0] = fitResponse(
              ctx,
              rows[start],
              labels,
              [LIST_ANSWER_CHARS, 200],
              remedy,
              RESULT_BUDGET_BYTES - jsonBytes({ ...result, items: [] }) - 1,
            );
            result = yield* build();
          }
          if (jsonBytes(result) > RESULT_BUDGET_BYTES) {
            throw new ConnectorCallError(
              "connector_call_failed",
              "A response on this page cannot be listed inside one result, even cut; read it with get_response and questionIds.",
              { retryable: false },
            );
          }
          const safe = standardResult(result);
          return {
            items: selectFields(result.items, args.fields) as JsonRecord[],
            page: result.page,
            ...(safe["truncated"] ? { truncated: safe["truncated"] } : {}),
          };
        }).pipe(knownFailures),
    }),
    read(connection, {
      name: "get_response",
      description:
        "Get one Google Form response whole, each answer labeled with its question's title, plus file ids, quiz grades, and feedback. questionIds narrows a large one.",
      input: Schema.Struct({
        formId,
        responseId: id("Response id from list_responses."),
        questionIds: Schema.optionalKey(
          Schema.Array(id("Question id from get_form or omittedQuestionIds."))
            .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_QUESTION_IDS), Schema.isUnique())
            .annotate({ description: "Return only these questions for a large response." }),
        ),
        fields: Schema.optionalKey(
          fieldsInput("Dot paths to keep in the response; cut and recovery metadata is preserved."),
        ),
      }),
      output: ResponseRecord,
      writeSteps: pairedReads,
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const problem = fieldsProblem(args.fields, new Set(Object.keys(ResponseRecord.fields)), "the response");
          if (problem) return yield* Effect.fail(new Refusal({ error: problem }));
          const formId: string = args["formId"];
          const [form, response] = yield* Effect.all(
            [
              readForm(formId, "form"),
              client.json(
                {
                  method: "GET",
                  path: `${formPath(formId)}/responses/${encodeURIComponent(args["responseId"])}`,
                  template: "/forms/{formId}/responses/{responseId}",
                },
                { step: "answers" },
              ),
            ],
            { concurrency: "unbounded" },
          );
          const wanted = Array.isArray(args["questionIds"]) ? new Set<string>(args["questionIds"]) : undefined;
          const record = asRecord(response);
          const narrowed = wanted
            ? {
                ...record,
                answers: Object.fromEntries(
                  Object.entries(asRecord(record["answers"])).filter(([key, answer]) =>
                    wanted.has(text(asRecord(answer)["questionId"]) ?? key),
                  ),
                ),
              }
            : record;
          // Whole when it fits; otherwise cut, then narrowed, with the ids left
          // out named so a call with questionIds reads them.
          const result = fitResponse(
            ctx,
            narrowed,
            questionLabels(ctx, form),
            [undefined, MAX_ANSWER_CHARS, LIST_ANSWER_CHARS],
            "more than one result carries; pass questionIds to read fewer answers, or read it in Forms",
            RESULT_BUDGET_BYTES,
          );
          if (jsonBytes(result) > RESULT_BUDGET_BYTES) {
            throw new ConnectorCallError(
              "invalid_args",
              "This response cannot be returned inside one result even with its answers cut; pass fewer questionIds.",
            );
          }
          const safe = standardResult(result);
          return {
            ...(selectFields(safe, args.fields) as JsonRecord),
            ...(safe["truncated"] ? { truncated: safe["truncated"] } : {}),
            ...(safe["omittedQuestionIds"] ? { omittedQuestionIds: safe["omittedQuestionIds"] } : {}),
          };
        }).pipe(knownFailures),
    }),
    write(connection, {
      name: "update_form_info",
      description:
        "Replace a Google Form's title, description, or both; what is omitted is kept. The old text is gone. Questions and settings need batch_update_form.",
      input: Schema.Struct({
        formId,
        title: Schema.optionalKey(string("New title; omit to preserve.", 1000)),
        description: Schema.optionalKey(
          Schema.String.check(isMaxChars(20000)).annotate({
            description: "New description; empty clears, omission preserves.",
          }),
        ),
        requiredRevisionId: Schema.optionalKey(revision),
      }),
      output: optional({ formId: Schema.String, revisionId: Schema.String }),
      destructive: true,
      run: (args) =>
        Effect.gen(function* () {
          const fields = (["title", "description"] as const).filter((field) => args[field] !== undefined);
          if (fields.length === 0) {
            throw new ConnectorCallError("invalid_args", "update_form_info needs a title, a description, or both.");
          }
          const { formId, revisionId } = yield* batch(
            args["formId"],
            [
              {
                updateFormInfo: {
                  info: compact({ title: args["title"], description: args["description"] }),
                  updateMask: fields.join(","),
                },
              },
            ],
            args["requiredRevisionId"],
          );
          return compact({ formId, revisionId });
        }).pipe(knownFailures),
    }),
    write(connection, {
      name: "batch_update_form",
      description:
        "Apply Forms API batchUpdate requests to a Google Form, all or none: create, update, move, or delete items, and change info or quiz settings. The host may ask the user to confirm this write.",
      input: Schema.Struct({
        formId,
        requests: Schema.Array(
          Schema.Struct(
            Object.fromEntries(
              FORMS_REQUEST_KINDS.map((kind) => [
                kind,
                Schema.optionalKey(
                  Schema.Record(Schema.String, Schema.Unknown).annotate({
                    description: `Forms ${kind} request body; use forms_api_details for nested properties.`,
                  }),
                ),
              ]),
            ),
          ).check(
            Schema.makeFilter((value) => Object.keys(value).length === 1, {
              expected: "exactly one reviewed request kind",
              toJsonSchema: () => ({ minProperties: 1, maxProperties: 1 }),
            }),
          ),
        )
          .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_REQUESTS))
          .annotate({
            description:
              "1–100 reviewed Forms requests, each exactly one kind. Locations are item indexes; use forms_api_details for nested request contracts.",
          }),
        requiredRevisionId: revision,
      }),
      output: BatchRecord,
      destructive: true,
      run: (args) => batch(args["formId"], args["requests"], args["requiredRevisionId"]).pipe(knownFailures),
    }),
  ];
}
