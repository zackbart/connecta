/**
 * Google Forms, as the signed-in Workspace user: read a form's questions,
 * create a form, read its responses, and edit it through Google's own
 * batchUpdate. Hand-written against the Forms API v1 reference
 * (https://developers.google.com/workspace/forms/api/reference/rest).
 *
 * Whose forms. Access is a service account with domain-wide delegation
 * (`src/providers/google/workspace.ts`): deployment config maps the admitted
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
import { apiConnector as api, defined, type ApiTool } from "../connectors/api-connector.js";
import { ConnectorCallError } from "../errors.js";
import type { Connector, ConnectorContext, JsonSchema } from "../types.js";
import {
  googleWorkspaceClient,
  workspaceConnection,
  type GoogleWorkspaceClient,
  type GoogleWorkspaceOptions,
} from "./google/workspace.js";

export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "./google/workspace.js";

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
/** A form or item description is cut here in get_form's projection. */
const DESCRIPTION_CHARS = 2_000;
/** Options shown per choice question; a long dropdown says how many it hid. */
const MAX_OPTIONS = 100;
/** Requests in one batch_update_form call. */
const MAX_REQUESTS = 100;
/** A large form with embedded media metadata, or a page of long answers. */
const FORMS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
  return `${value.slice(0, max)}\n[… ${value.length - max} more characters truncated; ${remedy}]`;
}

function editUrl(formId: string): string {
  return `https://docs.google.com/forms/d/${encodeURIComponent(formId)}/edit`;
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
    .map((option) => String(option["value"] ?? ""));
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
    title: text(item["title"]),
    description: capped(text(item["description"]), DESCRIPTION_CHARS, "pass raw: true to read it"),
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
        projectQuestion(question, text(asRecord(asRecord(question)["rowQuestion"])["title"])),
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
    title: text(info["title"]),
    documentTitle: text(info["documentTitle"]),
    description: capped(text(info["description"]), DESCRIPTION_CHARS, "pass raw: true to read it"),
    revisionId: text(form["revisionId"]),
    responderUri: text(form["responderUri"]),
    editUrl: formId ? editUrl(formId) : undefined,
    linkedSheetId: text(form["linkedSheetId"]),
    isQuiz: asRecord(settings["quizSettings"])["isQuiz"] === true,
    emailCollection: text(settings["emailCollectionType"]),
    // Absent on a legacy form, which has no publish settings at all.
    published: form["publishSettings"] ? publish["isPublished"] === true : undefined,
    acceptingResponses: form["publishSettings"] ? publish["isAcceptingResponses"] === true : undefined,
    questionCount: items.reduce((count, item) => count + asArray(item["questions"]).length, 0),
    items,
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
function projectFeedback(value: unknown, maxChars: number | undefined): JsonRecord | undefined {
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
    text: maxChars === undefined ? said : capped(said, maxChars, "get_response returns it whole"),
    links: links.length > 0 ? links : undefined,
  });
}

function projectResponse(value: unknown, labels: Map<string, QuestionLabel>, maxChars: number | undefined): JsonRecord {
  const response = asRecord(value);
  const answers = Object.entries(asRecord(response["answers"])).map(([key, raw]) => {
    const answer = asRecord(raw);
    const questionId = text(answer["questionId"]) ?? key;
    const grade = asRecord(answer["grade"]);
    const values = asArray(asRecord(answer["textAnswers"])["answers"]).map((entry) => {
      const value = String(asRecord(entry)["value"] ?? "");
      return maxChars === undefined ? value : capped(value, maxChars, "get_response returns it whole")!;
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
      feedback: projectFeedback(grade["feedback"], maxChars),
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

function projectBatch(formId: string, value: unknown): JsonRecord {
  const result = asRecord(value);
  return compact({
    formId,
    revisionId: text(asRecord(result["writeControl"])["requiredRevisionId"]),
    replies: projectReplies(result["replies"]),
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

const CURSOR_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  description: "Opaque page.nextCursor from the previous page. Pass it back unchanged with the same formId and submittedAfter.",
};

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
    questionCount: { type: "integer" },
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
      ),
    );

  return [
    {
      name: "get_form",
      description:
        "Get one Google Form: title, description, quiz and publish state, revisionId, and every item with its question ids, types, and options. Never lists forms; Drive does.",
      annotations: readOnly,
      inputSchema: input(
        {
          formId: FORM_ID_PROPERTY,
          raw: {
            type: "boolean",
            description: "Return Google's untouched Form resource (grading, images, section navigation) instead of the projection; read it before an updateItem that must keep them.",
          },
        },
        ["formId"],
      ),
      outputSchema: FORM_SCHEMA,
      handler: async (args, ctx) => {
        const form = await readForm(args["formId"], ctx);
        return args["raw"] === true ? form : projectForm(form);
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
        const form = asRecord(
          await client.json(
            {
              method: "POST",
              path: "/forms",
              query: { unpublished: args["unpublished"] === true ? true : undefined },
              body: { info: compact({ title: args["title"], documentTitle: args["documentTitle"] }) },
            },
            ctx,
          ),
        );
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
        "List a Google Form's submitted responses, each answer labeled with its question's title in form order. Long answers are cut; get_response returns one whole.",
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
          cursor: CURSOR_PROPERTY,
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
                pageSize: args["limit"] ?? DEFAULT_PAGE_SIZE,
                pageToken: args["cursor"],
              },
            },
            ctx,
          ),
        ]);
        const labels = questionLabels(form);
        const page = asRecord(listing);
        const next = text(page["nextPageToken"]) ?? null;
        return {
          formId,
          responses: asArray(page["responses"]).map((response) =>
            projectResponse(response, labels, LIST_ANSWER_CHARS),
          ),
          page: { hasMore: next !== null, nextCursor: next },
        };
      },
    },
    {
      name: "get_response",
      description:
        "Get one Google Form response whole, each answer labeled with its question's title, plus uploaded file ids and quiz grades and feedback where present.",
      annotations: readOnly,
      inputSchema: input(
        {
          formId: FORM_ID_PROPERTY,
          responseId: idProperty("Response id from list_responses."),
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
        return projectResponse(response, questionLabels(form), undefined);
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
  return `# Google Forms usage

Acts as the signed-in person in Google Forms through Workspace delegation: read and edit their forms, read responses, never submit or delete.

Connection purpose: ${purpose}

## Whose forms

Every call reaches only the forms the Workspace user deployment config maps
the caller to can open. No argument names a user. A call with none mapped
fails \`auth_required\`; only an operator can change the mapping. A form id
that does not exist and one not shared with that user fail alike, as
\`connector_call_failed\`: Google does not say which.

## Finding forms

There is no list or search here: the Forms API has none. Find a form in
Drive, or take its id from an edit URL (\`/forms/d/<formId>/edit\`). The
\`/forms/d/e/…\` responder link is not the form id.

## Reading

- \`get_form\` lists every item with its \`questions\`: one for a question,
  one per row for a grid, none for sections and media. Answers are keyed by
  those \`questionId\`s. Long descriptions are cut with a marker; \`raw:
  true\` returns Google's whole Form resource.
- \`list_responses\` labels each answer with its question's title, in form
  order; an answer to a since-deleted question has no title. Answers longer
  than ${LIST_ANSWER_CHARS} characters end with a truncation marker; \`get_response\`
  returns one whole. Page with \`page.nextCursor\` and the same
  \`submittedAfter\`. To read only new responses, pass the newest
  \`lastSubmittedTime\` already seen as \`submittedAfter\`.

## Editing

- \`create_form\` makes an empty form: Google takes only its title and Drive
  file name at creation. Add a description and questions afterwards.
- \`update_form_info\` replaces the title or description.
- \`batch_update_form\` is the escape hatch for everything else, and always
  needs approval. It takes Google's own Request objects, applied all or none,
  with the form's current \`revisionId\` as \`requiredRevisionId\`: a form
  someone changed since you read it is refused, so re-read it and rebuild the
  edit. Its reply carries the new \`revisionId\` and each created item's id.
  An \`updateItem\` needs an \`updateMask\`; read \`raw: true\` first so the
  item it replaces keeps its grading, images, and navigation.
- Publishing, sharing, deleting, and watches are not in this connection; the
  owner does those in Forms or Drive. Responses are read-only.
${extra ? `\n## Connection instructions\n\n${extra}\n` : ""}`;
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
export function forms(id: string, options: FormsOptions): Connector {
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
