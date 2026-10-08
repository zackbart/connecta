import { skill } from "./skill.generated.js";
/**
 * Google Forms, as the signed-in Workspace user: read a form's questions,
 * create a form, read its responses, and edit it through Google's own
 * batchUpdate. Hand-written against the Forms API v1 reference
 * (https://developers.google.com/workspace/forms/api/reference/rest).
 *
 * Whose forms. Access is a service account with domain-wide delegation
 * (`src/providers/_shared/google/workspace.ts`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. The Forms API has no per-user path to confine beneath — a form id
 * is a Drive file id — so the token's subject is what decides what a request
 * can reach: exactly the forms that person can open in Forms.
 *
 * What it does not do. Listing forms is Drive's job (a Drive files query for
 * `mimeType = 'application/vnd.google-apps.form'`); the Forms API has no list
 * method and this connection requests no Drive scope. Deleting,
 * sharing, and publishing are Drive or `setPublishSettings`, outside both of
 * this connection's scopes or its surface, and watches (push notifications)
 * are out of scope entirely. Responses are read-only: `forms.responses.readonly`
 * is the only response scope requested.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `scripts/drift/forms-endpoints.json` records the five methods the tools
 * call, and `npm run providers:check -- --provider forms` reports a touched
 * contract that moved or a method that stopped accepting the scopes below.
 */
import { apiConnector as api, defined, type ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import type { Connector, ConnectorContext, JsonSchema } from "../../types.js";
import { clampText, jsonBytes, RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import {
  googleOutcomeOf,
  GOOGLE_WORKSPACE_OPTIONS,
  googleWorkspaceClient,
  workspaceConnection,
  type GoogleWorkspaceClient,
  type GoogleWorkspaceOptions,
} from "../_shared/google/workspace.js";
import { defineProvider } from "../../provider.js";

export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";

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

/** Options for {@link forms}: the shared Workspace delegation options. */
export type FormsOptions = GoogleWorkspaceOptions;

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
/** An option or grid row is cut here; raw: true reads it whole. */
const MAX_LABEL_CHARS = 300;
const MAX_LABEL_BYTES = 1024;
/** One answer value in get_response, before it would crowd out the rest. */
const MAX_ANSWER_CHARS = 50_000;
/** Question ids one get_response call may name. */
const MAX_QUESTION_IDS = 100;
/** Requests in one batch_update_form call. */
const MAX_REQUESTS = 100;
/** A large form with embedded media metadata, or a page of long answers. */
const FORMS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
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
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Cut text at `max` characters and say so in the text itself. */
function capped(value: string | undefined, max: number, remedy: string): string | undefined {
  if (value === undefined || value.length <= max) return value;
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
function bounded(value: string | undefined, chars: number, bytes: number): string | undefined {
  const cut = capped(value, chars, "pass raw: true to read it");
  if (cut === undefined || jsonBytes(cut) <= bytes) return cut;
  return clampText(value!, bytes, (dropped) => `\n[… ${dropped} more characters truncated; pass raw: true to read it]`);
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

function encodeCursor(cursor: JsonRecord): string {
  return base64Url(encoder.encode(JSON.stringify(cursor)));
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
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    cursor = asRecord(JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))));
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

function choiceOptions(choice: JsonRecord): JsonRecord {
  const all = asArray(choice["options"]).map(asRecord);
  const hasOther = all.some((option) => option["isOther"] === true);
  const values = all
    .filter((option) => option["isOther"] !== true)
    .map((option) => bounded(String(option["value"] ?? ""), MAX_LABEL_CHARS, MAX_LABEL_BYTES) ?? "");
  return compact({
    options: values.slice(0, MAX_OPTIONS),
    moreOptions: values.length > MAX_OPTIONS ? values.length - MAX_OPTIONS : undefined,
    hasOther: hasOther || undefined,
  });
}

/** One question's id, type, and the shape of what it accepts. */
function projectQuestion(value: unknown, rowTitle?: string): JsonRecord {
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
    return compact({ ...base, type: CHOICE_TYPES[String(choice["type"])] ?? "unknown", ...choiceOptions(choice) });
  }
  if (question["textQuestion"]) {
    return compact({ ...base, type: asRecord(question["textQuestion"])["paragraph"] === true ? "paragraph" : "short_text" });
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
function projectItem(value: unknown): JsonRecord {
  const item = asRecord(value);
  const base = {
    itemId: text(item["itemId"]),
    title: bounded(text(item["title"]), DESCRIPTION_CHARS, DESCRIPTION_BYTES),
    description: bounded(text(item["description"]), DESCRIPTION_CHARS, DESCRIPTION_BYTES),
  };
  if (item["questionItem"]) {
    return compact({
      ...base,
      kind: "question" satisfies ItemKind,
      questions: [projectQuestion(asRecord(item["questionItem"])["question"])],
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
      gridType: group["grid"] ? CHOICE_TYPES[String(columns["type"])] ?? "unknown" : undefined,
      ...(group["grid"] ? choiceOptions(columns) : {}),
      questions: asArray(group["questions"]).map((question) =>
        projectQuestion(
          question,
          bounded(text(asRecord(asRecord(question)["rowQuestion"])["title"]), MAX_LABEL_CHARS, MAX_LABEL_BYTES),
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

function projectForm(value: unknown): JsonRecord {
  const form = asRecord(value);
  const info = asRecord(form["info"]);
  const settings = asRecord(form["settings"]);
  const publish = asRecord(asRecord(form["publishSettings"])["publishState"]);
  const formId = text(form["formId"]);
  const items = asArray(form["items"]).map(projectItem);
  return compact({
    formId,
    title: bounded(text(info["title"]), DESCRIPTION_CHARS, DESCRIPTION_BYTES),
    documentTitle: bounded(text(info["documentTitle"]), DESCRIPTION_CHARS, DESCRIPTION_BYTES),
    description: bounded(text(info["description"]), DESCRIPTION_CHARS, DESCRIPTION_BYTES),
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
function questionLabels(form: unknown): Map<string, QuestionLabel> {
  const labels = new Map<string, QuestionLabel>();
  for (const value of asArray(asRecord(form)["items"])) {
    const item = projectItem(value);
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
function projectFeedback(value: unknown, maxChars: number | undefined, remedy: string): JsonRecord | undefined {
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
    text: maxChars === undefined ? said : capped(said, maxChars, remedy),
    links: links.length > 0 ? links : undefined,
  });
}

function projectResponse(
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
      return maxChars === undefined ? value : capped(value, maxChars, remedy)!;
    });
    const files = asArray(asRecord(answer["fileUploadAnswers"])["answers"]).map((entry) => {
      const file = asRecord(entry);
      return compact({ fileId: text(file["fileId"]), fileName: text(file["fileName"]), mimeType: text(file["mimeType"]) });
    });
    return compact({
      questionId,
      // Undefined for a question deleted since this response was submitted.
      title: labels.get(questionId)?.title,
      values: files.length > 0 && values.length === 0 ? undefined : values,
      files: files.length > 0 ? files : undefined,
      score: typeof grade["score"] === "number" ? grade["score"] : undefined,
      correct: typeof grade["correct"] === "boolean" ? grade["correct"] : undefined,
      feedback: projectFeedback(grade["feedback"], maxChars, remedy),
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
  value: unknown,
  labels: Map<string, QuestionLabel>,
  caps: readonly (number | undefined)[],
  remedy: string,
  budget: number,
): JsonRecord {
  let projected: JsonRecord = {};
  for (const cap of caps) {
    projected = projectResponse(value, labels, cap, remedy);
    if (jsonBytes(projected) <= budget) return projected;
  }
  const answers = asArray(projected["answers"]).map(asRecord);
  const kept: JsonRecord[] = [];
  let used = jsonBytes({ ...projected, answers: [], omittedQuestionIds: answers.map((answer) => answer["questionId"]) });
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
    truncated: true,
    note,
  });
  if (jsonBytes(idsOnly) <= RESULT_BUDGET_BYTES) return idsOnly;
  return compact({
    formId,
    revisionId: revisionId && jsonBytes(revisionId) <= 1024 ? revisionId : undefined,
    replies: [],
    replyCount: replies.length,
    createdItemCount: replies.filter((reply) => reply["createdItemId"] !== undefined).length,
    truncated: true,
    note: revisionId && jsonBytes(revisionId) <= 1024 ? note : `${note} Read its revisionId there too.`,
  });
}

// --- Schemas ----------------------------------------------------------------------

function input(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const ID_PATTERN = "^[A-Za-z0-9_-]+$";

function idProperty(description: string): JsonSchema {
  return { type: "string", minLength: 1, maxLength: 256, pattern: ID_PATTERN, description };
}

const FORM_ID_PROPERTY = idProperty(
  "Form id: the part after /forms/d/ in its edit URL, a Drive file id, or create_form's formId. Not the /forms/d/e/… responder link.",
);

const REVISION_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^\\S+$",
  description: "revisionId from get_form, create_form, or the previous edit. Google refuses the edit if the form changed since; re-read it and retry.",
};

function cursorProperty(same: string): JsonSchema {
  return {
    type: "string",
    minLength: 1,
    maxLength: 4096,
    description: `Opaque page.nextCursor from the previous page. Pass it back unchanged with the same ${same}.`,
  };
}

const LIMIT_PROPERTY: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PAGE_SIZE,
  description: `Responses per page, 1 to ${MAX_PAGE_SIZE}; defaults to ${DEFAULT_PAGE_SIZE}. Connecta's cap, far below Google's 5,000; page with the cursor.`,
};

const RFC3339_UTC = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$";

const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hasMore: { type: "boolean" },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["hasMore", "nextCursor"],
};

const FILE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    fileId: { type: "string" },
    fileName: { type: "string" },
    mimeType: { type: "string" },
  },
};

const FEEDBACK_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    links: {
      type: "array",
      items: {
        type: "object",
        properties: {
          uri: { type: "string" },
          displayText: { type: "string" },
          video: { type: "boolean" },
        },
      },
    },
  },
};

const RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    responseId: { type: "string" },
    createTime: { type: "string" },
    lastSubmittedTime: { type: "string" },
    respondentEmail: { type: "string" },
    totalScore: { type: "number" },
    omittedQuestionIds: { type: "array", items: { type: "string" } },
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionId: { type: "string" },
          title: { type: "string" },
          values: { type: "array", items: { type: "string" } },
          files: { type: "array", items: FILE_SCHEMA },
          score: { type: "number" },
          correct: { type: "boolean" },
          feedback: FEEDBACK_SCHEMA,
        },
      },
    },
  },
};

/** A choice question's, or a grid's shared, options. */
const CHOICE_PROPERTIES: Record<string, JsonSchema> = {
  options: { type: "array", items: { type: "string" } },
  moreOptions: { type: "integer" },
  hasOther: { type: "boolean" },
};

const QUESTION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    questionId: { type: "string" },
    type: { type: "string" },
    rowTitle: { type: "string" },
    required: { type: "boolean" },
    points: { type: "integer" },
    ...CHOICE_PROPERTIES,
    scale: {
      type: "object",
      properties: {
        low: { type: "integer" },
        high: { type: "integer" },
        lowLabel: { type: "string" },
        highLabel: { type: "string" },
      },
    },
    includesYear: { type: "boolean" },
    includesTime: { type: "boolean" },
    duration: { type: "boolean" },
  },
};

/**
 * get_form's result. Only `formId` is required, because `raw: true` returns
 * Google's own Form resource instead, where ProtoJSON omits every empty field —
 * an empty form has no `items` at all. The projection always carries `items`.
 */
const FORM_SCHEMA: JsonSchema = {
  type: "object",
  description: "The projection; with raw: true, Google's Form resource (formId, info, settings, publishSettings, items, revisionId), empty fields omitted.",
  properties: {
    formId: { type: "string" },
    title: { type: "string" },
    documentTitle: { type: "string" },
    description: { type: "string" },
    revisionId: { type: "string" },
    responderUri: { type: "string" },
    editUrl: { type: "string" },
    linkedSheetId: { type: "string" },
    isQuiz: { type: "boolean" },
    emailCollection: { type: "string" },
    published: { type: "boolean" },
    acceptingResponses: { type: "boolean" },
    itemCount: { type: "integer" },
    questionCount: { type: "integer" },
    page: PAGE_SCHEMA,
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          kind: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          gridType: { type: "string" },
          ...CHOICE_PROPERTIES,
          questions: { type: "array", items: QUESTION_SCHEMA },
          questionsFrom: { type: "integer" },
          moreQuestions: { type: "integer" },
        },
      },
    },
  },
  required: ["formId"],
};

/**
 * One Forms `Request`: exactly one of Google's six kinds, each shaped as
 * Google documents it. The kind is closed here; its body is Google's.
 */
function requestKind(description: string): JsonSchema {
  return { type: "object", description };
}

const REQUEST_SCHEMA: JsonSchema = {
  type: "object",
  minProperties: 1,
  maxProperties: 1,
  additionalProperties: false,
  properties: {
    createItem: requestKind("{ item, location: { index } }"),
    updateItem: requestKind("{ item, location: { index }, updateMask }"),
    deleteItem: requestKind("{ location: { index } }"),
    moveItem: requestKind("{ originalLocation, newLocation }"),
    updateFormInfo: requestKind("{ info: { title?, description? }, updateMask }"),
    updateSettings: requestKind("{ settings: { quizSettings?, emailCollectionType? }, updateMask }"),
  },
};

// --- Tools ------------------------------------------------------------------------

function tools(client: GoogleWorkspaceClient): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;
  const formPath = (formId: string) => `/forms/${encodeURIComponent(formId)}`;
  const readForm = (formId: string, ctx: ConnectorContext) =>
    client.json({ method: "GET", path: formPath(formId) }, ctx);
  const batch = async (formId: string, requests: unknown[], revisionId: string | undefined, ctx: ConnectorContext) =>
    projectBatch(
      formId,
      await client.json(
        {
          method: "POST",
          path: `${formPath(formId)}:batchUpdate`,
          body: compact({
            requests,
            writeControl: revisionId ? { requiredRevisionId: revisionId } : undefined,
          }),
        },
        ctx,
        // A named revision makes Google's refused precondition mean "the form
        // moved on", which the shared client reports as `conflict`.
        { revisionGuarded: revisionId !== undefined },
      ),
    );

  return [
    {
      name: "get_form",
      description:
        "Get one Google Form: title, description, quiz and publish state, revisionId, and its items with question ids, types, and options, paged when large. Never lists forms.",
      annotations: readOnly,
      inputSchema: input(
        {
          formId: FORM_ID_PROPERTY,
          raw: {
            type: "boolean",
            description: "Return Google's untouched Form resource (grading, images, section navigation) instead of the projection; read it before an updateItem that must keep them. Not paged: a form too large for one result is refused.",
          },
          cursor: cursorProperty("formId"),
        },
        ["formId"],
      ),
      outputSchema: FORM_SCHEMA,
      handler: async (args, ctx) => {
        const formId: string = args["formId"];
        if (args["raw"] === true && args["cursor"] !== undefined) {
          throw new ConnectorCallError("invalid_args", "raw: true is not paged; omit cursor.");
        }
        const form = await readForm(formId, ctx);
        if (args["raw"] === true) {
          const size = jsonBytes(form);
          if (size > RESULT_BUDGET_BYTES) {
            throw new ConnectorCallError(
              "invalid_args",
              `This form's raw resource is ${size} bytes, more than one result carries (${RESULT_BUDGET_BYTES}). Read the projection, which pages its items with page.nextCursor, or edit with the item indexes it lists.`,
            );
          }
          return form;
        }
        const { items, ...header } = projectForm(form);
        const all = asArray(items).map(asRecord);
        const revision = text(asRecord(form)["revisionId"]) ?? "";
        const digest = await digestOf(["get_form", formId]);
        // A cursor names an item and, inside a grid too large for one page,
        // the first of its questions not yet returned, so every question id
        // is reachable by paging, however many rows one grid has.
        let start = 0;
        let from = 0;
        if (typeof args["cursor"] === "string") {
          const cursor = decodeCursor(
            args["cursor"],
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
        const build = () => {
          const lastIndex = start + kept.length - 1;
          const last = kept[kept.length - 1];
          let next: JsonRecord | undefined;
          if (last?.["moreQuestions"]) {
            const before = lastIndex === start ? from : 0;
            next = { d: digest, i: lastIndex, q: before + asArray(last["questions"]).length, r: revision };
          } else if (lastIndex + 1 < all.length) {
            next = { d: digest, i: lastIndex + 1, q: 0, r: revision };
          }
          const nextCursor = next ? encodeCursor(next) : null;
          return { ...header, page: { hasMore: nextCursor !== null, nextCursor }, items: kept };
        };
        // The estimate above reserved room; the complete result, cursor and
        // all, is what has to fit.
        let result = build();
        while (jsonBytes(result) > RESULT_BUDGET_BYTES && kept.length > 1) {
          kept.pop();
          result = build();
        }
        if (jsonBytes(result) > RESULT_BUDGET_BYTES && kept.length === 1) {
          // Measured with the longest cursor this page could carry.
          const room = RESULT_BUDGET_BYTES - jsonBytes({ ...result, items: [] }) - 64;
          kept[0] = fitItem(piece(start), room);
          result = build();
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
        return result;
      },
    },
    {
      name: "create_form",
      description:
        "Create an empty Google Form with a title in the user's Drive. Google sets only the title here: add questions and a description with batch_update_form.",
      // Additive: a new, empty form changes nothing that existed. Not
      // read-only, so it crosses call_destructive_tool unless the deployment
      // exempts it in `execute.approval`; the provider never exempts itself.
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: input(
        {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 1_000,
            description: "Title responders see.",
          },
          documentTitle: {
            type: "string",
            minLength: 1,
            maxLength: 1_000,
            description: "File name in Drive; defaults to the title. It cannot be changed through this connection later.",
          },
          unpublished: {
            type: "boolean",
            description: "Create it not accepting responses. This connection cannot publish it later; the owner does, in Forms. Omit to publish.",
          },
        },
        ["title"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          formId: { type: "string" },
          title: { type: "string" },
          documentTitle: { type: "string" },
          revisionId: { type: "string" },
          responderUri: { type: "string" },
          editUrl: { type: "string" },
        },
        required: ["formId"],
      },
      handler: async (args, ctx) => {
        let created: unknown;
        try {
          created = await client.json(
            {
              method: "POST",
              path: "/forms",
              query: { unpublished: args["unpublished"] === true ? true : undefined },
              body: { info: compact({ title: args["title"], documentTitle: args["documentTitle"] }) },
            },
            ctx,
          );
        } catch (error) {
          // Sent and not refused — no answer, a 5xx or redirect after Google received
          // it, or a reply that broke: the form may exist, and there is no
          // form id to re-read. Another create would make a second one, so
          // say where to look first. The shared verdict (not retryable)
          // stands. No Forms write is sent as idempotent: a create, a batch,
          // and an info update are each not safe to send twice blind.
          // Any phase that is neither "never sent" nor "explicitly refused"
          // is uncertain, so a phase the shared layer adds later is too.
          const outcome = googleOutcomeOf(error);
          if (
            error instanceof ConnectorCallError &&
            outcome?.dispatched === true &&
            outcome.phase !== "refused" &&
            outcome.phase !== "before-send"
          ) {
            throw new ConnectorCallError(
              error.code,
              `${error.message} create_form makes a new form on every call: look for "${args["documentTitle"] ?? args["title"]}" in the user's Drive, or ask them, before creating it again.`,
              { retryable: false, cause: error },
            );
          }
          throw error;
        }
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
      },
    },
    {
      name: "list_responses",
      description:
        "List a Google Form's submitted responses, each answer labeled with its question's title in form order. Long answers are cut; get_response reads one whole.",
      annotations: readOnly,
      inputSchema: input(
        {
          formId: FORM_ID_PROPERTY,
          submittedAfter: {
            type: "string",
            pattern: RFC3339_UTC,
            description: "Only responses submitted after this UTC instant (exclusive), e.g. 2026-10-01T00:00:00Z or the newest lastSubmittedTime already read.",
          },
          limit: LIMIT_PROPERTY,
          cursor: cursorProperty("formId and submittedAfter"),
        },
        ["formId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          formId: { type: "string" },
          responses: { type: "array", items: RESPONSE_SCHEMA },
          page: PAGE_SCHEMA,
        },
        required: ["formId", "responses", "page"],
      },
      handler: async (args, ctx) => {
        const formId: string = args["formId"];
        const limit: number = args["limit"] ?? DEFAULT_PAGE_SIZE;
        const digest = await digestOf(["list_responses", formId, args["submittedAfter"] ?? null]);
        // A cursor names Google's page (its token and size) and, when a page
        // ended early to stay inside its byte budget, the last response it
        // returned and a fingerprint of that Google page's ordered response
        // ids. The next call re-reads the page and continues strictly after
        // that response only if the page is exactly as it was: Google promises
        // neither a stable order nor a snapshot, so a reordered, grown, or
        // shrunk page could repeat, skip, or cycle, and is refused instead.
        // Moving to Google's next page needs none of this: its token is Google's.
        const resume = typeof args["cursor"] === "string"
          ? decodeCursor(
              args["cursor"],
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
        const [form, listing] = await Promise.all([
          readForm(formId, ctx),
          client.json(
            {
              method: "GET",
              path: `${formPath(formId)}/responses`,
              query: {
                filter: args["submittedAfter"] ? `timestamp > ${args["submittedAfter"]}` : undefined,
                pageSize: size,
                pageToken: token ?? undefined,
              },
            },
            ctx,
          ),
        ]);
        const labels = questionLabels(form);
        const page = asRecord(listing);
        const rows = asArray(page["responses"]);
        const idOf = (row: unknown) => text(asRecord(row)["responseId"]);
        const pageHash = await digestOf(["page", ...rows.map((row) => idOf(row) ?? null)]);
        let start = 0;
        if (anchor !== null) {
          const at = rows.findIndex((row) => idOf(row) === anchor);
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
        let used = jsonBytes({ formId, responses: [], page: { hasMore: true, nextCursor: null } }) + PAGE_RESERVE_BYTES;
        for (let index = start; index < rows.length; index += 1) {
          const room = RESULT_BUDGET_BYTES - used;
          let response = projectResponse(rows[index], labels, LIST_ANSWER_CHARS, remedy);
          if (jsonBytes(response) + 1 > room) {
            if (responses.length > 0) break;
            response = fitResponse(rows[index], labels, [LIST_ANSWER_CHARS, 200], remedy, room - 1);
          }
          responses.push(response);
          used += jsonBytes(response) + 1;
        }
        const googleNext = text(page["nextPageToken"]) ?? null;
        const build = () => {
          const last = start + responses.length - 1;
          // Rows left on Google's page: continue after the last one returned.
          // A page that ended on an anchor with nothing after it has no
          // response of its own to anchor on, and moves to Google's next page.
          let next: JsonRecord | undefined;
          if (start + responses.length < rows.length && responses.length > 0) {
            const after = idOf(rows[last]);
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
          const nextCursor = next ? encodeCursor(next) : null;
          return { formId, responses, page: { hasMore: nextCursor !== null, nextCursor } };
        };
        let result = build();
        while (jsonBytes(result) > RESULT_BUDGET_BYTES && responses.length > 1) {
          responses.pop();
          result = build();
        }
        if (jsonBytes(result) > RESULT_BUDGET_BYTES && responses.length === 1) {
          responses[0] = fitResponse(
            rows[start],
            labels,
            [LIST_ANSWER_CHARS, 200],
            remedy,
            RESULT_BUDGET_BYTES - jsonBytes({ ...result, responses: [] }) - 1,
          );
          result = build();
        }
        if (jsonBytes(result) > RESULT_BUDGET_BYTES) {
          throw new ConnectorCallError(
            "connector_call_failed",
            "A response on this page cannot be listed inside one result, even cut; read it with get_response and questionIds.",
            { retryable: false },
          );
        }
        return result;
      },
    },
    {
      name: "get_response",
      description:
        "Get one Google Form response whole, each answer labeled with its question's title, plus file ids, quiz grades, and feedback. questionIds narrows a large one.",
      annotations: readOnly,
      inputSchema: input(
        {
          formId: FORM_ID_PROPERTY,
          responseId: idProperty("Response id from list_responses."),
          questionIds: {
            type: "array",
            minItems: 1,
            maxItems: MAX_QUESTION_IDS,
            uniqueItems: true,
            items: idProperty("Question id from get_form, or from omittedQuestionIds."),
            description: "Return only these questions' answers, for a response too large to read whole in one result.",
          },
        },
        ["formId", "responseId"],
      ),
      outputSchema: { ...RESPONSE_SCHEMA, required: ["responseId", "answers"] },
      handler: async (args, ctx) => {
        const formId: string = args["formId"];
        const [form, response] = await Promise.all([
          readForm(formId, ctx),
          client.json(
            { method: "GET", path: `${formPath(formId)}/responses/${encodeURIComponent(args["responseId"])}` },
            ctx,
          ),
        ]);
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
          narrowed,
          questionLabels(form),
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
        return result;
      },
    },
    {
      name: "update_form_info",
      description:
        "Replace a Google Form's title, description, or both; what is omitted is kept. The old text is gone. Questions and settings need batch_update_form.",
      // Destructive: the title or description it replaces is not recoverable
      // through this connection.
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: input(
        {
          formId: FORM_ID_PROPERTY,
          title: {
            type: "string",
            minLength: 1,
            maxLength: 1_000,
            description: "New title responders see; omit to keep it.",
          },
          description: {
            type: "string",
            maxLength: 20_000,
            description: "New description; an empty string clears it. Omit to keep it.",
          },
          requiredRevisionId: { ...REVISION_PROPERTY, description: `Optional. ${REVISION_PROPERTY.description}` },
        },
        ["formId"],
      ),
      outputSchema: {
        type: "object",
        properties: { formId: { type: "string" }, revisionId: { type: "string" } },
        required: ["formId"],
      },
      handler: async (args, ctx) => {
        const fields = (["title", "description"] as const).filter((field) => args[field] !== undefined);
        if (fields.length === 0) {
          throw new ConnectorCallError("invalid_args", "update_form_info needs a title, a description, or both.");
        }
        const { formId, revisionId } = await batch(
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
          ctx,
        );
        return compact({ formId, revisionId });
      },
    },
    {
      name: "batch_update_form",
      description:
        "Apply Forms API batchUpdate requests to a Google Form, all or none: create, update, move, or delete items, and change info or quiz settings. Always needs approval.",
      // Destructive whatever it carries: a deleteItem or an updateItem loses
      // what it replaces, and the requests are Google's to interpret.
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: input(
        {
          formId: FORM_ID_PROPERTY,
          requests: {
            type: "array",
            minItems: 1,
            maxItems: MAX_REQUESTS,
            items: REQUEST_SCHEMA,
            description: `1 to ${MAX_REQUESTS} Forms API Request objects, each exactly one kind, applied in order as Google documents them. Locations are item indexes.`,
          },
          requiredRevisionId: REVISION_PROPERTY,
        },
        ["formId", "requests", "requiredRevisionId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          formId: { type: "string" },
          revisionId: { type: "string" },
          replies: {
            type: "array",
            items: {
              type: "object",
              properties: {
                createdItemId: { type: "string" },
                createdQuestionIds: { type: "array", items: { type: "string" } },
              },
            },
          },
          truncated: { type: "boolean" },
          note: { type: "string" },
          replyCount: { type: "integer" },
          createdItemCount: { type: "integer" },
        },
        required: ["formId", "replies"],
      },
      handler: (args, ctx) => batch(args["formId"], args["requests"], args["requiredRevisionId"], ctx),
    },
  ];
}

// --- Guide ------------------------------------------------------------------------

function usageGuide(purpose: string, instructions: string | undefined): string {
  const extra = instructions?.trim();
  return `${skill.fragments.guide_0}${purpose}${skill.fragments.guide_1}${RESULT_BUDGET_BYTES / 1024}${skill.fragments.guide_2}${LIST_ANSWER_CHARS}${skill.fragments.guide_3}${extra ? `\n## ${skill.instructionsHeading}\n\n${extra}\n` : ""}`;
}

// --- Construction -----------------------------------------------------------------

/**
 * A maintained Google Forms connection acting as each signed-in Workspace
 * user through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Forms API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches users' forms.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new (or edit
 *    the entry another Workspace provider already made for this client ID, and
 *    append to its scopes). Paste the client ID and exactly these scopes,
 *    comma-separated ({@link FORMS_SCOPES}):
 *    `https://www.googleapis.com/auth/forms.body,https://www.googleapis.com/auth/forms.responses.readonly`.
 *    A new grant can take up to 24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * forms("forms", {
 *   purpose: "Event registration forms and their responses",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * Listing forms needs Drive, which this connection does not request; pair it
 * with a Drive connection for that. `create_form` is an additive write the
 * host approves unless the deployment exempts it in `execute.approval`;
 * `update_form_info` and `batch_update_form` are destructive.
 */
export const forms = defineProvider<FormsOptions>({
  name: "forms",
  title: "Google Forms",
  kind: "api",
  readme: "Google Forms",
  bundle: {"baselineGzip":26161,"maxGzip":86161,"note":"./providers/forms starts at 26,161 B gzip (#684): the same class as ./providers/gmail — a hand-written api() surface over the shared Workspace delegation layer, with no OAuth client and no MCP SDK. The cap uses the existing baseline + 60,000 B policy."},
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  create: formsConnector,
});

function formsConnector(id: string, options: FormsOptions): Connector {
  const connection = workspaceConnection("forms", options);
  const client = googleWorkspaceClient({
    provider: "Google Forms",
    api: "Google Forms API",
    baseUrl: options.baseUrl?.trim() || FORMS_API_BASE_URL,
    scopes: FORMS_SCOPES,
    maxResponseBytes: FORMS_MAX_RESPONSE_BYTES,
    // A form is a Drive file: Google answers 404 alike for one that does not
    // exist and one this user cannot open, so a 404 is not proof of absence.
    notFound: "ambiguous",
    connection,
  });
  return api(id, {
    ...defined({
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
    title: options.title ?? "Google Forms",
    description: `Google Forms as the signed-in Workspace user: read and edit forms, read responses — ${connection.purpose}`,
    usageGuide: {
      content: usageGuide(connection.purpose, options.instructions),
      summary: "Each caller's own forms: questions by id, labeled responses, revision-checked batch edits.",
      // Required: whose forms they are, that Drive lists them, and the
      // revision-checked edit sequence are conventions no schema can carry.
      required: true,
    },
    tools: tools(client),
  });
}
