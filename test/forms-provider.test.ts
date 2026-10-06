// The Google Forms connection. Tests stub the network and pin the requests
// each tool sends, the projections it returns, and the surface it refuses to
// have — H1, H9, H10, H11, and H14 for this provider. Delegation, subjects,
// and tokens are test/google-workspace-delegation.test.ts; one fail-closed
// case is repeated here so this connection is seen to inherit them.
import { Validator } from "@cfworker/json-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCaller } from "../src/connector-caller.js";
import { FORMS_API_BASE_URL, FORMS_SCOPES, forms } from "../src/providers/forms.js";
import { jsonBytes, RESULT_BUDGET_BYTES } from "../src/providers/google/result-size.js";
import { memoryStorage } from "../src/storage/memory.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import { silentLogger } from "./helpers.js";
import type { AuthenticatedIdentity, Connector, ConnectorContext, ConnectorUsageGuide } from "../src/types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const keys = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;

interface ApiCall {
  url: URL;
  method: string;
  body: any;
}

type Route = (call: ApiCall) => { status?: number; body?: unknown } | undefined;

const calls: ApiCall[] = [];
let tokenMints = 0;
let route: Route = () => undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  tokenMints = 0;
  route = () => undefined;
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      tokenMints += 1;
      return Response.json({ access_token: "token", expires_in: 3599 });
    }
    const call: ApiCall = {
      url: new URL(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = route(call) ?? {};
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

let accounts = 0;
function connection(overrides: Record<string, unknown> = {}): Connector {
  accounts += 1;
  return forms("forms", {
    purpose: "Event registration",
    serviceAccount: { clientEmail: `forms-${accounts}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
    subject: "office@church.example",
    ...overrides,
  } as Parameters<typeof forms>[1]);
}

function context(): ConnectorContext {
  return { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" };
}

function call(connector: Connector, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return connector.callTool(name, args, context()) as Promise<any>;
}

function guide(connector: Connector): ConnectorUsageGuide {
  if (typeof connector.usageGuide !== "object" || !connector.usageGuide) {
    throw new Error("expected a structured guide");
  }
  return connector.usageGuide;
}

const path = (index: number) => calls[index]!.url.pathname.replace("/v1", "");

const FORM = {
  formId: "form-1",
  revisionId: "00000042",
  responderUri: "https://docs.google.com/forms/d/e/1FAIpQ/viewform",
  linkedSheetId: "sheet-9",
  info: {
    title: "Retreat sign-up",
    documentTitle: "Retreat sign-up (2026)",
    description: "Fall retreat.",
  },
  settings: { quizSettings: { isQuiz: false }, emailCollectionType: "VERIFIED" },
  publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } },
  items: [
    {
      itemId: "i1",
      title: "Which session?",
      questionItem: {
        question: {
          questionId: "q1",
          required: true,
          choiceQuestion: {
            type: "RADIO",
            shuffle: true,
            options: [{ value: "Morning" }, { value: "Evening", goToAction: "SUBMIT_FORM" }, { isOther: true }],
          },
        },
      },
    },
    {
      itemId: "i2",
      title: "Dietary needs",
      description: "Anything we should know.",
      questionItem: { question: { questionId: "q2", textQuestion: { paragraph: true } } },
    },
    { itemId: "i3", title: "Logistics", pageBreakItem: {} },
    {
      itemId: "i4",
      title: "How excited are you?",
      questionItem: {
        question: {
          questionId: "q3",
          scaleQuestion: { low: 1, high: 5, lowLabel: "Meh", highLabel: "Very" },
        },
      },
    },
    {
      itemId: "i5",
      title: "Availability",
      questionGroupItem: {
        grid: { columns: { type: "CHECKBOX", options: [{ value: "Fri" }, { value: "Sat" }] } },
        questions: [
          { questionId: "q4", required: true, rowQuestion: { title: "Adults" } },
          { questionId: "q5", rowQuestion: { title: "Children" } },
        ],
      },
    },
    { itemId: "i6", title: "Map", imageItem: { image: { contentUri: "https://lh3.example/map" } } },
    {
      itemId: "i7",
      title: "Arrival date",
      questionItem: { question: { questionId: "q6", dateQuestion: { includeYear: true } } },
    },
  ],
};

const RESPONSE = {
  responseId: "r1",
  createTime: "2026-10-01T12:00:00.000Z",
  lastSubmittedTime: "2026-10-01T12:05:00.000Z",
  respondentEmail: "ann@church.example",
  answers: {
    q2: {
      questionId: "q2",
      textAnswers: { answers: [{ value: "x".repeat(2_500) }] },
      grade: {
        score: 0,
        correct: false,
        feedback: {
          text: `See the allergy guide. ${"f".repeat(2_100)}`,
          material: [
            { link: { uri: "https://church.example/allergies", displayText: "Allergy guide" } },
            { video: { youtubeUri: "https://www.youtube.com/watch?v=abc", displayText: "Kitchen safety" } },
          ],
        },
      },
    },
    q1: { questionId: "q1", textAnswers: { answers: [{ value: "Evening" }] } },
    q5: { questionId: "q5", textAnswers: { answers: [{ value: "Fri" }, { value: "Sat" }] } },
    gone: { questionId: "gone", textAnswers: { answers: [{ value: "from a deleted question" }] } },
    q9: {
      questionId: "q9",
      fileUploadAnswers: { answers: [{ fileId: "f1", fileName: "waiver.pdf", mimeType: "application/pdf" }] },
    },
  },
};

describe("forms() identity and surface (H1, H14)", () => {
  it("requires a purpose and names the routing fact in title, description, and guide", () => {
    expect(() => connection({ purpose: " " })).toThrow(/purpose/);
    const connector = connection({ instructions: "Retreat forms live in the Events folder." });
    expect(connector.title).toBe("Google Forms");
    expect(connector.description).toContain("signed-in Workspace user");
    expect(connector.description).toContain("Event registration");
    const content = guide(connector).content;
    expect(content.split("\n").find((line) => line && !line.startsWith("#"))).toMatch(/Workspace delegation/);
    expect(content).toContain("## Connection instructions\n\nRetreat forms live in the Events folder.");
    expect(content).toContain("no list or search");
    expect(guide(connector).required).toBe(true);
    expect(guide(connector).summary!.length).toBeLessThanOrEqual(120);
  });

  it("has no tool that lists forms, deletes, publishes, submits, or watches", async () => {
    const tools = await connection().listTools(context());
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "batch_update_form",
      "create_form",
      "get_form",
      "get_response",
      "list_responses",
      "update_form_info",
    ]);
    expect(tools.some((tool) => /list_forms|search|delete|publish|submit|watch|share/.test(tool.name))).toBe(false);
  });

  it("classifies reads as read-only, create as additive, and every overwrite as destructive", async () => {
    const connector = connection();
    const tools = await connector.listTools(context());
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    for (const name of ["get_form", "list_responses", "get_response"]) {
      expect(byName[name]!.annotations).toEqual({ readOnlyHint: true });
      expect(isExplicitlyReadOnly(byName[name]!)).toBe(true);
    }
    expect(byName["create_form"]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(byName["update_form_info"]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(byName["batch_update_form"]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    // The provider never exempts a write from approval, and has no slot.
    expect(connector.approval).toBeUndefined();
    expect(connector.credential).toBeUndefined();
    expect(connector.startAuth).toBeUndefined();
  });

  it("requests exactly forms.body and forms.responses.readonly", () => {
    expect([...FORMS_SCOPES]).toEqual([
      "https://www.googleapis.com/auth/forms.body",
      "https://www.googleapis.com/auth/forms.responses.readonly",
    ]);
    expect(FORMS_API_BASE_URL).toBe("https://forms.googleapis.com/v1");
  });
});

describe("whose forms", () => {
  function identity(id: string): AuthenticatedIdentity {
    return {
      actor: { kind: "test-users", id, namespace: "https://identity.test" },
      subject: { namespace: "https://identity.test", id },
      principal: { namespace: "https://identity.test", id },
      interactive: true,
    };
  }

  it("fails closed with a function subject and no admitted caller, before any network call", async () => {
    const mapping = vi.fn(() => "ann@church.example");
    const connector = connection({ subject: mapping });
    await expect(call(connector, "get_form", { formId: "form-1" })).rejects.toMatchObject({
      code: "auth_required",
    });
    expect(mapping).not.toHaveBeenCalled();
    expect(tokenMints).toBe(0);
    expect(calls).toEqual([]);
  });

  it("acts as the account the mapping names for the admitted caller", async () => {
    route = () => ({ body: FORM });
    const connector = connection({ subject: (who: AuthenticatedIdentity) => `${who.principal?.id}@church.example` });
    const ctx = attachCaller(context(), { identity: identity("ann"), authenticated: true });
    await connector.callTool("get_form", { formId: "form-1" }, ctx);
    expect(tokenMints).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("reading forms (H9)", () => {
  it("projects a form's items into questions with ids, types, and options", async () => {
    route = () => ({ body: FORM });
    const result = await call(connection(), "get_form", { formId: "form-1" });
    expect(calls[0]!.method).toBe("GET");
    expect(`${calls[0]!.url.origin}${calls[0]!.url.pathname}`).toBe(`${FORMS_API_BASE_URL}/forms/form-1`);
    expect(calls[0]!.url.search).toBe("");
    expect(result).toEqual({
      formId: "form-1",
      title: "Retreat sign-up",
      documentTitle: "Retreat sign-up (2026)",
      description: "Fall retreat.",
      revisionId: "00000042",
      responderUri: "https://docs.google.com/forms/d/e/1FAIpQ/viewform",
      editUrl: "https://docs.google.com/forms/d/form-1/edit",
      linkedSheetId: "sheet-9",
      isQuiz: false,
      emailCollection: "VERIFIED",
      published: true,
      acceptingResponses: true,
      itemCount: 7,
      questionCount: 6,
      page: { hasMore: false, nextCursor: null },
      items: [
        {
          itemId: "i1",
          title: "Which session?",
          kind: "question",
          questions: [
            { questionId: "q1", required: true, type: "radio", options: ["Morning", "Evening"], hasOther: true },
          ],
        },
        {
          itemId: "i2",
          title: "Dietary needs",
          description: "Anything we should know.",
          kind: "question",
          questions: [{ questionId: "q2", required: false, type: "paragraph" }],
        },
        { itemId: "i3", title: "Logistics", kind: "page_break" },
        {
          itemId: "i4",
          title: "How excited are you?",
          kind: "question",
          questions: [
            {
              questionId: "q3",
              required: false,
              type: "scale",
              scale: { low: 1, high: 5, lowLabel: "Meh", highLabel: "Very" },
            },
          ],
        },
        {
          itemId: "i5",
          title: "Availability",
          kind: "question_group",
          gridType: "checkbox",
          options: ["Fri", "Sat"],
          questions: [
            { questionId: "q4", rowTitle: "Adults", required: true, type: "grid_row" },
            { questionId: "q5", rowTitle: "Children", required: false, type: "grid_row" },
          ],
        },
        { itemId: "i6", title: "Map", kind: "image" },
        {
          itemId: "i7",
          title: "Arrival date",
          kind: "question",
          questions: [
            { questionId: "q6", required: false, type: "date", includesYear: true, includesTime: false },
          ],
        },
      ],
    });
    // Presentation and navigation noise is dropped from the projection.
    expect(JSON.stringify(result)).not.toMatch(/shuffle|goToAction|contentUri/);
  });

  it("returns Google's untouched form on raw: true", async () => {
    route = () => ({ body: FORM });
    expect(await call(connection(), "get_form", { formId: "form-1", raw: true })).toEqual(FORM);
  });

  it("caps long descriptions and option lists with explicit markers", async () => {
    const options = Array.from({ length: 130 }, (_, index) => ({ value: `Option ${index}` }));
    route = () => ({
      body: {
        formId: "form-2",
        info: { title: "Big", description: "d".repeat(2_100) },
        items: [{ itemId: "i1", title: "Pick", questionItem: { question: { questionId: "q1", choiceQuestion: { type: "DROP_DOWN", options } } } }],
      },
    });
    const result = await call(connection(), "get_form", { formId: "form-2" });
    expect(result.description).toBe(`${"d".repeat(2_000)}\n[… 100 more characters truncated; pass raw: true to read it]`);
    const question = result.items[0].questions[0];
    expect(question.type).toBe("drop_down");
    expect(question.options).toHaveLength(100);
    expect(question.moreOptions).toBe(30);
    // A legacy form has no publish settings, and says nothing rather than false.
    expect(result.published).toBeUndefined();
    expect(result.acceptingResponses).toBeUndefined();
  });

  it("refuses an id that is not a form id before any request", async () => {
    for (const formId of ["../drive/v3/files", "a/b", "", "form 1"]) {
      await expect(call(connection(), "get_form", { formId })).rejects.toMatchObject({ code: "invalid_args" });
    }
    await expect(call(connection(), "get_form", { formId: "f", fields: "*" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toEqual([]);
  });
});

/** No lone surrogate anywhere: what String.prototype.isWellFormed checks. */
function wellFormed(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

describe("cuts never split a surrogate pair", () => {
  // The emoji straddles each cut: its high surrogate is the last unit kept.
  const straddle = (keep: number) => `${"a".repeat(keep - 1)}😀${"z".repeat(50)}`;

  it("at the title, description, option, and row boundaries of a form", async () => {
    route = () => ({
      body: {
        formId: "e",
        info: { title: straddle(2_000), description: straddle(2_000) },
        items: [
          {
            itemId: "i1",
            title: straddle(2_000),
            questionItem: {
              question: { questionId: "q1", choiceQuestion: { type: "RADIO", options: [{ value: straddle(300) }] } },
            },
          },
          {
            itemId: "i2",
            title: "Grid",
            questionGroupItem: {
              grid: { columns: { type: "RADIO", options: [{ value: "x" }] } },
              questions: [{ questionId: "q2", rowQuestion: { title: straddle(300) } }],
            },
          },
        ],
      },
    });
    const result = await call(connection(), "get_form", { formId: "e" });
    const cut = [
      result.title,
      result.description,
      result.items[0].title,
      result.items[0].questions[0].options[0],
      result.items[1].questions[0].rowTitle,
    ];
    for (const value of cut) {
      expect(value).toContain("more characters truncated");
      expect(wellFormed(value)).toBe(true);
    }
    // The pair is dropped whole, and counted: 50 + the two units of the emoji.
    expect(result.title).toMatch(/^a{1999}\n\[… 52 more characters truncated/);
  });

  it("at a listed answer's boundary", async () => {
    route = (request) =>
      request.url.pathname.endsWith("/responses")
        ? {
            body: {
              responses: [
                { responseId: "r1", answers: { q1: { questionId: "q1", textAnswers: { answers: [{ value: straddle(2_000) }] } } } },
              ],
            },
          }
        : { body: FORM };
    const result = await call(connection(), "list_responses", { formId: "form-1" });
    const value = result.responses[0].answers[0].values[0];
    expect(value).toMatch(/^a{1999}\n\[… 52 more characters truncated; get_response reads it whole\]$/);
    expect(wellFormed(value)).toBe(true);
  });
});

describe("reading responses (H9, H10)", () => {
  it("lists responses labeled by question title, in form order, with long answers cut", async () => {
    route = (request) =>
      request.url.pathname.endsWith("/responses")
        ? { body: { responses: [RESPONSE], nextPageToken: "page-2" } }
        : { body: FORM };
    const result = await call(connection(), "list_responses", {
      formId: "form-1",
      submittedAfter: "2026-09-30T00:00:00Z",
      limit: 5,
    });

    const list = calls.find((entry) => entry.url.pathname.endsWith("/responses"))!;
    expect(list.method).toBe("GET");
    expect(list.url.pathname).toBe("/v1/forms/form-1/responses");
    expect(Object.fromEntries(list.url.searchParams)).toEqual({
      filter: "timestamp > 2026-09-30T00:00:00Z",
      pageSize: "5",
    });
    expect(calls.map((entry) => `${entry.method} ${entry.url.pathname}`).sort()).toEqual([
      "GET /v1/forms/form-1",
      "GET /v1/forms/form-1/responses",
    ]);

    expect(result.formId).toBe("form-1");
    expect(result.page.hasMore).toBe(true);
    expect(result.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const [response] = result.responses;
    expect(response).toMatchObject({
      responseId: "r1",
      createTime: "2026-10-01T12:00:00.000Z",
      lastSubmittedTime: "2026-10-01T12:05:00.000Z",
      respondentEmail: "ann@church.example",
    });
    expect(response.answers.map((answer: any) => [answer.questionId, answer.title])).toEqual([
      ["q1", "Which session?"],
      ["q2", "Dietary needs"],
      ["q5", "Availability [Children]"],
      ["gone", undefined],
      ["q9", undefined],
    ]);
    expect(response.answers[0].values).toEqual(["Evening"]);
    expect(response.answers[1].values[0]).toBe(
      `${"x".repeat(2_000)}\n[… 500 more characters truncated; get_response reads it whole]`,
    );
    // A grader's feedback survives the projection, its text cut like an answer.
    expect(response.answers[1]).toMatchObject({ score: 0, correct: false });
    expect(response.answers[1].feedback.text).toMatch(
      /^See the allergy guide\. f+\n\[… 123 more characters truncated; get_response reads it whole\]$/,
    );
    expect(response.answers[1].feedback.links).toEqual([
      { uri: "https://church.example/allergies", displayText: "Allergy guide" },
      { uri: "https://www.youtube.com/watch?v=abc", displayText: "Kitchen safety", video: true },
    ]);
    expect(response.answers[2].values).toEqual(["Fri", "Sat"]);

    // The cursor carries Google's token and page size back, for this same call only.
    calls.length = 0;
    await call(connection(), "list_responses", {
      formId: "form-1",
      submittedAfter: "2026-09-30T00:00:00Z",
      cursor: result.page.nextCursor,
    });
    const next = calls.find((entry) => entry.url.pathname.endsWith("/responses"))!;
    expect(Object.fromEntries(next.url.searchParams)).toEqual({
      filter: "timestamp > 2026-09-30T00:00:00Z",
      pageSize: "5",
      pageToken: "page-2",
    });
    calls.length = 0;
    for (const args of [
      { formId: "form-1", cursor: result.page.nextCursor },
      { formId: "form-2", submittedAfter: "2026-09-30T00:00:00Z", cursor: result.page.nextCursor },
      { formId: "form-1", cursor: "page-2" },
    ]) {
      await expect(call(connection(), "list_responses", args)).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toEqual([]);
    expect(response.answers[4]).toEqual({
      questionId: "q9",
      files: [{ fileId: "f1", fileName: "waiver.pdf", mimeType: "application/pdf" }],
    });
  });

  it("ends paging with one branchable signal and a default page below Google's maximum", async () => {
    route = () => ({ body: {} });
    const result = await call(connection(), "list_responses", { formId: "form-1" });
    expect(result).toEqual({ formId: "form-1", responses: [], page: { hasMore: false, nextCursor: null } });
    const list = calls.find((entry) => entry.url.pathname.endsWith("/responses"))!;
    expect(Object.fromEntries(list.url.searchParams)).toEqual({ pageSize: "25" });
  });

  it("refuses a page size past its cap and a timestamp Google would not parse", async () => {
    await expect(call(connection(), "list_responses", { formId: "f", limit: 101 })).rejects.toMatchObject({
      code: "invalid_args",
    });
    for (const submittedAfter of ["2026-09-30", "2026-09-30T00:00:00+02:00", "yesterday"]) {
      await expect(call(connection(), "list_responses", { formId: "f", submittedAfter })).rejects.toMatchObject({
        code: "invalid_args",
      });
    }
    expect(calls).toEqual([]);
  });

  it("gets one response whole, with grades", async () => {
    route = (request) =>
      request.url.pathname.includes("/responses/")
        ? {
            body: {
              ...RESPONSE,
              formId: "form-1",
              totalScore: 3,
              answers: {
                ...RESPONSE.answers,
                q1: { questionId: "q1", grade: { score: 3, correct: true }, textAnswers: { answers: [{ value: "Evening" }] } },
              },
            },
          }
        : { body: FORM };
    const result = await call(connection(), "get_response", { formId: "form-1", responseId: "r1" });
    expect(calls.map((entry) => entry.url.pathname).sort()).toEqual([
      "/v1/forms/form-1",
      "/v1/forms/form-1/responses/r1",
    ]);
    expect(result.totalScore).toBe(3);
    expect(result.answers[0]).toEqual({ questionId: "q1", title: "Which session?", values: ["Evening"], score: 3, correct: true });
    expect(result.answers[1].values[0]).toHaveLength(2_500);
    expect(result.answers[1].feedback).toEqual({
      text: `See the allergy guide. ${"f".repeat(2_100)}`,
      links: [
        { uri: "https://church.example/allergies", displayText: "Allergy guide" },
        { uri: "https://www.youtube.com/watch?v=abc", displayText: "Kitchen safety", video: true },
      ],
    });
    expect(result.formId).toBeUndefined();
  });
});

/**
 * Every key a result carries, at every depth, that its output schema does not
 * declare. Output schemas are open, so validation alone would pass a
 * projection that grew a field the schema never learned about.
 */
function undeclared(value: unknown, schema: any, path: string, found: string[]): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) undeclared(entry, schema?.items, `${path}[]`, found);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const property = schema?.properties?.[key];
      if (!property) found.push(`${path}.${key}`);
      else undeclared(entry, property, `${path}.${key}`, found);
    }
  }
  return found;
}

/** A result validates against its tool's output schema, which declares every key it carries. */
async function conforms(connector: Connector, name: string, result: unknown, projected = true) {
  const tool = (await connector.listTools(context())).find((candidate) => candidate.name === name)!;
  const validation = new Validator(tool.outputSchema as never, "2020-12", false).validate(result);
  expect(validation.errors, name).toEqual([]);
  if (projected) expect(undeclared(result, tool.outputSchema, name, []), name).toEqual([]);
}

describe("output schemas declare what each tool returns (H8)", () => {
  /** Every question kind, a grid, quiz grading, and an over-long option list. */
  const RICH_FORM = {
    ...FORM,
    settings: { quizSettings: { isQuiz: true }, emailCollectionType: "RESPONDER_INPUT" },
    info: { ...FORM.info, description: "d".repeat(2_100) },
    items: [
      ...FORM.items,
      {
        itemId: "i8",
        title: "Arrival time",
        description: "e".repeat(2_100),
        questionItem: { question: { questionId: "q7", timeQuestion: { duration: true } } },
      },
      {
        itemId: "i9",
        title: "Meal",
        questionItem: {
          question: {
            questionId: "q8",
            grading: { pointValue: 2, correctAnswers: { answers: [{ value: "Soup" }] } },
            choiceQuestion: {
              type: "DROP_DOWN",
              options: Array.from({ length: 105 }, (_, index) => ({ value: `Meal ${index}` })),
            },
          },
        },
      },
      {
        itemId: "i10",
        title: "Rate it",
        questionItem: { question: { questionId: "q9", ratingQuestion: { ratingScaleLevel: 5, iconType: "STAR" } } },
      },
      {
        itemId: "i11",
        title: "Waiver",
        questionItem: { question: { questionId: "q10", fileUploadQuestion: { folderId: "folder" } } },
      },
      {
        itemId: "i12",
        title: "Seat",
        questionGroupItem: {
          grid: { columns: { type: "RADIO", options: [{ value: "Front" }, { value: "Back" }, { isOther: true }] } },
          questions: [{ questionId: "q11", rowQuestion: { title: "Adults" } }],
        },
      },
      { itemId: "i13", title: "Welcome", textItem: {} },
      { itemId: "i14", title: "Tour", videoItem: { video: { youtubeUri: "https://youtube.example" } } },
    ],
  };

  it("declares every key of a projected form, and validates Google's empty raw form", async () => {
    const connector = connection();
    route = () => ({ body: RICH_FORM });
    const projected = await call(connector, "get_form", { formId: "form-1" });
    // The fixture reaches every branch the projection has.
    expect(JSON.stringify(projected)).toMatch(/includesYear[\s\S]*duration[\s\S]*moreOptions[\s\S]*gridType/);
    await conforms(connector, "get_form", projected);

    // ProtoJSON omits empty repeated fields: a new form has no `items` key.
    const empty = { formId: "new-1", revisionId: "00000001", info: { title: "Untitled", documentTitle: "Untitled" } };
    route = () => ({ body: empty });
    const raw = await call(connector, "get_form", { formId: "new-1", raw: true });
    expect(raw).toEqual(empty);
    await conforms(connector, "get_form", raw, false);
    // Its projection still lists the (empty) items.
    const projectedEmpty = await call(connector, "get_form", { formId: "new-1" });
    expect(projectedEmpty.items).toEqual([]);
    await conforms(connector, "get_form", projectedEmpty);
  });

  it("declares every key of listed and fetched responses", async () => {
    const connector = connection();
    route = (request) =>
      request.url.pathname.endsWith("/responses")
        ? { body: { responses: [{ ...RESPONSE, totalScore: 1 }], nextPageToken: "next" } }
        : request.url.pathname.includes("/responses/")
          ? { body: { ...RESPONSE, totalScore: 1 } }
          : { body: RICH_FORM };
    await conforms(connector, "list_responses", await call(connector, "list_responses", { formId: "form-1" }));
    await conforms(
      connector,
      "get_response",
      await call(connector, "get_response", { formId: "form-1", responseId: "r1" }),
    );
  });

  it("declares every key of each write's result", async () => {
    const connector = connection();
    route = (request) =>
      request.url.pathname.endsWith(":batchUpdate")
        ? {
            body: {
              writeControl: { requiredRevisionId: "00000002" },
              replies: [{ createItem: { itemId: "i1", questionId: ["q1"] } }],
            },
          }
        : {
            body: {
              formId: "new-1",
              revisionId: "00000001",
              responderUri: "https://docs.google.com/forms/d/e/x/viewform",
              info: { title: "New", documentTitle: "New" },
            },
          };
    await conforms(connector, "create_form", await call(connector, "create_form", { title: "New" }));
    await conforms(connector, "update_form_info", await call(connector, "update_form_info", { formId: "new-1", title: "Newer" }));
    await conforms(
      connector,
      "batch_update_form",
      await call(connector, "batch_update_form", {
        formId: "new-1",
        requiredRevisionId: "00000001",
        requests: [{ createItem: { item: { title: "Q", questionItem: { question: { textQuestion: {} } } }, location: { index: 0 } } }],
      }),
    );
  });
});

describe("writing forms", () => {
  it("creates a form with only a title and Drive name, published unless asked not to", async () => {
    route = () => ({
      body: {
        formId: "new-1",
        revisionId: "00000001",
        responderUri: "https://docs.google.com/forms/d/e/1FAIpNew/viewform",
        info: { title: "Volunteer roster", documentTitle: "Roster" },
      },
    });
    const result = await call(connection(), "create_form", { title: "Volunteer roster", documentTitle: "Roster" });
    expect(calls[0]!.method).toBe("POST");
    expect(path(0)).toBe("/forms");
    expect(calls[0]!.url.search).toBe("");
    expect(calls[0]!.body).toEqual({ info: { title: "Volunteer roster", documentTitle: "Roster" } });
    expect(result).toEqual({
      formId: "new-1",
      title: "Volunteer roster",
      documentTitle: "Roster",
      revisionId: "00000001",
      responderUri: "https://docs.google.com/forms/d/e/1FAIpNew/viewform",
      editUrl: "https://docs.google.com/forms/d/new-1/edit",
    });

    calls.length = 0;
    await call(connection(), "create_form", { title: "Draft survey", unpublished: true });
    expect(calls[0]!.url.searchParams.get("unpublished")).toBe("true");
    expect(calls[0]!.body).toEqual({ info: { title: "Draft survey" } });

    // Description, items, and settings are refused by Google at creation, and
    // so by the schema here.
    await expect(
      call(connection(), "create_form", { title: "x", description: "y" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("replaces only the info fields it is given, with the revision guard when passed", async () => {
    route = () => ({ body: { writeControl: { requiredRevisionId: "00000043" }, replies: [{}] } });
    const result = await call(connection(), "update_form_info", {
      formId: "form-1",
      description: "",
      requiredRevisionId: "00000042",
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/v1/forms/form-1:batchUpdate");
    expect(calls[0]!.body).toEqual({
      requests: [{ updateFormInfo: { info: { description: "" }, updateMask: "description" } }],
      writeControl: { requiredRevisionId: "00000042" },
    });
    expect(result).toEqual({ formId: "form-1", revisionId: "00000043" });

    calls.length = 0;
    await call(connection(), "update_form_info", { formId: "form-1", title: "Retreat 2026", description: "Bring a coat." });
    expect(calls[0]!.body).toEqual({
      requests: [
        { updateFormInfo: { info: { title: "Retreat 2026", description: "Bring a coat." }, updateMask: "title,description" } },
      ],
    });
  });

  it("refuses an info update that changes nothing, before any request", async () => {
    await expect(call(connection(), "update_form_info", { formId: "form-1" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toEqual([]);
  });

  it("passes batch requests through whole, under the required revision, and projects the replies", async () => {
    const requests = [
      {
        createItem: {
          item: { title: "Phone number", questionItem: { question: { required: true, textQuestion: {} } } },
          location: { index: 0 },
        },
      },
      { deleteItem: { location: { index: 4 } } },
      { updateSettings: { settings: { quizSettings: { isQuiz: true } }, updateMask: "quizSettings.isQuiz" } },
    ];
    route = () => ({
      body: {
        form: { formId: "form-1" },
        writeControl: { requiredRevisionId: "00000044" },
        replies: [{ createItem: { itemId: "i9", questionId: ["q9"] } }, {}, {}],
      },
    });
    const result = await call(connection(), "batch_update_form", {
      formId: "form-1",
      requests,
      requiredRevisionId: "00000043",
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/v1/forms/form-1:batchUpdate");
    expect(calls[0]!.body).toEqual({ requests, writeControl: { requiredRevisionId: "00000043" } });
    expect(result).toEqual({
      formId: "form-1",
      revisionId: "00000044",
      replies: [{ createdItemId: "i9", createdQuestionIds: ["q9"] }, {}, {}],
    });
  });

  it.each([
    // 100 grids of 3,000 rows: every row's question id, ~4.5 MB of reply.
    [
      "drops question ids and keeps each created item's id",
      (index: number) => ({
        createItem: {
          itemId: `item${index}`,
          questionId: Array.from({ length: 3_000 }, (_, row) => `q${index}-${row}-abcdef`),
        },
      }),
      (result: any) => {
        expect(result.replies).toHaveLength(100);
        expect(result.replies[7]).toEqual({ createdItemId: "item7" });
      },
    ],
    // Item ids too long for even the id-only reply: counts are what is left.
    [
      "keeps only counts when even the item ids cannot fit",
      (index: number) => ({ createItem: { itemId: `${index}-${"x".repeat(3_000)}`, questionId: ["q"] } }),
      (result: any) => {
        expect(result.replies).toEqual([]);
        expect(result.replyCount).toBe(100);
        expect(result.createdItemCount).toBe(100);
      },
    ],
  ])("bounds a batch reply too large to return whole, and still reports it applied: %s", async (_case, reply, check) => {
    route = () => ({
      body: {
        writeControl: { requiredRevisionId: "00000050" },
        replies: Array.from({ length: 100 }, (_, index) => reply(index)),
      },
    });
    const connector = connection();
    const result = await call(connector, "batch_update_form", {
      formId: "form-1",
      requiredRevisionId: "00000049",
      requests: Array.from({ length: 100 }, () => ({
        createItem: { item: { title: "Grid", questionGroupItem: {} }, location: { index: 0 } },
      })),
    });
    expect(jsonBytes(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(result).toMatchObject({ formId: "form-1", revisionId: "00000050", truncated: true });
    expect(result.note).toMatch(/^The batch applied\./);
    expect(result.note).not.toMatch(/nothing|not applied|failed/i);
    check(result);
    await conforms(connector, "batch_update_form", result);
  });

  it("refuses a batch without a revision, an unknown request kind, or two kinds in one request", async () => {
    const createItem = { item: { title: "x", textItem: {} }, location: { index: 0 } };
    for (const args of [
      { formId: "form-1", requests: [{ createItem }] },
      { formId: "form-1", requests: [], requiredRevisionId: "1" },
      { formId: "form-1", requests: [{ setPublishSettings: {} }], requiredRevisionId: "1" },
      { formId: "form-1", requests: [{ createItem, deleteItem: { location: { index: 0 } } }], requiredRevisionId: "1" },
      { formId: "form-1", requests: [{ createItem }], requiredRevisionId: "1", includeFormInResponse: true },
    ]) {
      await expect(call(connection(), "batch_update_form", args)).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toEqual([]);
  });
});

describe("a write whose outcome is unknown is never told to retry", () => {
  /** Google's API answers with `reply`; the token endpoint answers normally. */
  function answer(reply: () => Promise<Response>) {
    globalThis.fetch = vi.fn(async (input: unknown) =>
      String(input) === TOKEN_URL ? Response.json({ access_token: "token", expires_in: 3599 }) : await reply(),
    ) as unknown as typeof fetch;
  }
  /** A 200 whose JSON body breaks off mid-stream. */
  const broken = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"formId":"new-1","replies":['));
          controller.error(new TypeError("connection reset"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  /** Sent, and no response at all. */
  const silent = async (): Promise<Response> => {
    throw new TypeError("fetch failed");
  };
  /** Google received it and answered 5xx: it may still have applied. */
  const serverError = async () =>
    Response.json({ error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } }, { status: 503 });

  const batch = {
    formId: "form-1",
    requests: [{ deleteItem: { location: { index: 0 } } }],
    requiredRevisionId: "00000042",
  };

  it.each([
    ["whose 2xx body breaks mid-stream", broken, "probably applied"],
    ["that gets no response", silent, "may or may not have been applied"],
    ["answered with a 5xx", serverError, "outcome is unknown"],
  ])("reports an edit %s as uncertain, not retryable", async (_case, reply, says) => {
    answer(reply);
    for (const [name, args] of [
      ["batch_update_form", batch],
      ["update_form_info", { formId: "form-1", title: "New title" }],
    ] as const) {
      const failure = await call(connection(), name, args).catch((error) => error);
      expect(failure, name).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(failure.message, name).toContain(says);
      expect(failure.message, name).not.toMatch(/nothing was applied|safe to retry|retry it/i);
    }
  });

  it.each([
    ["whose 2xx body breaks mid-stream", broken, "probably applied"],
    ["that gets no response", silent, "may or may not have been applied"],
    ["answered with a 5xx", serverError, "outcome is unknown"],
  ])("tells a create %s to look for the form before creating another", async (_case, reply, says) => {
    answer(reply);
    const failure = await call(connection(), "create_form", { title: "Volunteer roster", documentTitle: "Roster" }).catch(
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain(says);
    expect(failure.message).toContain('look for "Roster" in the user\'s Drive');
  });

  it("keeps a 5xx on a read retryable: no Forms write is sent as idempotent, but a read is safe", async () => {
    answer(serverError);
    const failure = await call(connection(), "get_form", { formId: "form-1" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "unavailable", retryable: true });
  });

  it("leaves a refused create as Google refused it", async () => {
    route = () => ({ status: 400, body: { error: { code: 400, message: "Title too long.", status: "INVALID_ARGUMENT" } } });
    const failure = await call(connection(), "create_form", { title: "x" }).catch((error) => error);
    expect(failure.code).toBe("invalid_args");
    expect(failure.message).not.toContain("look for");
  });
});

describe("errors (H11)", () => {
  it("never calls a 404 absent: a form is a Drive file the user may not see", async () => {
    route = () => ({ status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } });
    const failure = await call(connection(), "get_form", { formId: "hidden" }).catch((error) => error);
    expect(failure.code).toBe("connector_call_failed");
    expect(failure.code).not.toBe("not_found");
    expect(failure.message).toContain("not visible to this account");
  });

  const staleBatch = {
    formId: "form-1",
    requests: [{ deleteItem: { location: { index: 0 } } }],
    requiredRevisionId: "00000041",
  };

  it.each([
    [400, "FAILED_PRECONDITION"],
    [409, "ABORTED"],
  ])("maps a revision-guarded write's HTTP %i %s to conflict, so the caller re-reads", async (status, reason) => {
    route = () => ({
      status,
      body: { error: { code: status, message: "The form has changed since the required revision.", status: reason } },
    });
    const failure = await call(connection(), "batch_update_form", staleBatch).catch((error) => error);
    expect(failure).toMatchObject({ code: "conflict", retryable: false });
    expect(failure.message).toContain("changed after the revision it named");
    expect(calls).toHaveLength(1);

    // update_form_info is guarded exactly when it names a revision.
    calls.length = 0;
    await expect(
      call(connection(), "update_form_info", { formId: "form-1", title: "T", requiredRevisionId: "00000041" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(calls[0]!.body.writeControl).toEqual({ requiredRevisionId: "00000041" });
    calls.length = 0;
    const unguarded = await call(connection(), "update_form_info", { formId: "form-1", title: "T" }).catch(
      (error) => error,
    );
    expect(calls[0]!.body.writeControl).toBeUndefined();
    expect(unguarded.code).not.toBe("conflict");
  });

  it("passes any other refusal of a guarded write through as Google classed it", async () => {
    route = () => ({
      status: 400,
      body: { error: { code: 400, message: "Invalid requests[0].deleteItem: index out of range.", status: "INVALID_ARGUMENT" } },
    });
    await expect(call(connection(), "batch_update_form", staleBatch)).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("index out of range"),
    });
  });

  it("names the exact scopes when the delegated grant lacks one", async () => {
    route = () => ({
      status: 403,
      body: { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
    });
    const failure = await call(connection(), "list_responses", { formId: "form-1" }).catch((error) => error);
    expect(failure.code).toBe("auth_required");
    expect(failure.message).toContain(FORMS_SCOPES.join(","));
  });

  it("names the API to enable when the project has not", async () => {
    route = () => ({
      status: 403,
      body: { error: { code: 403, message: "Google Forms API has not been used in project 1.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } },
    });
    const failure = await call(connection(), "get_form", { formId: "form-1" }).catch((error) => error);
    expect(failure.code).toBe("connector_call_failed");
    expect(failure.message).toContain("Google Forms API is not enabled");
  });

  it("carries Google's stated wait on a rate limit", async () => {
    route = () => ({ status: 429, body: { error: { code: 429, message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" } } });
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (String(input) === TOKEN_URL) return Response.json({ access_token: "token", expires_in: 3599 });
      return Response.json(
        { error: { code: 429, message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" } },
        { status: 429, headers: { "Retry-After": "7" } },
      );
    }) as unknown as typeof fetch;
    await expect(call(connection(), "get_form", { formId: "form-1" })).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 7_000,
    });
  });
});

// Every result must cross execute_code's host bridge, which refuses one
// serialized host result over 256 KiB (`MAX_HOST_RESULT_BYTES` in
// src/executors/quickjs-runtime.ts), as well as a direct call's inline cap.
// These build the largest inputs the projections allow and page through them.
describe("worst-case results fit one host result (256 KiB)", () => {
  const BRIDGE_BYTES = 256 * 1024;
  const bridged = (value: unknown) => new TextEncoder().encode(JSON.stringify({ ok: true, value })).length;
  /**
   * Three-byte characters, UTF-8's widest in the BMP, past the 2,000-character
   * listing cut. Fixtures stay under the 8 MiB upstream ceiling, so what is
   * measured is the projection, not a refused read.
   */
  const long = (chars: number) => "日".repeat(chars);
  const LONG = long(5_000);

  function paragraphForm(questions: number) {
    return {
      formId: "big",
      revisionId: "00000007",
      info: { title: "Big survey" },
      items: Array.from({ length: questions }, (_, index) => ({
        itemId: `i${index}`,
        title: `Question ${index} ${"題".repeat(300)}`,
        questionItem: { question: { questionId: `q${index}`, textQuestion: { paragraph: true } } },
      })),
    };
  }

  function responses(count: number, questions: number, value = LONG) {
    return Array.from({ length: count }, (_, index) => ({
      responseId: `r${index}`,
      lastSubmittedTime: "2026-10-01T12:00:00Z",
      answers: Object.fromEntries(
        Array.from({ length: questions }, (_, question) => [
          `q${question}`,
          { questionId: `q${question}`, textAnswers: { answers: [{ value }] } },
        ]),
      ),
    }));
  }

  /** A responses route that pages like Google: by token and page size. */
  function serve(form: unknown, rows: unknown[]): Route {
    return (request) => {
      if (!request.url.pathname.endsWith("/responses")) return { body: form };
      const offset = Number(request.url.searchParams.get("pageToken")?.slice(1) ?? 0);
      const size = Number(request.url.searchParams.get("pageSize"));
      const end = offset + size;
      return {
        body: {
          responses: rows.slice(offset, end),
          ...(end < rows.length ? { nextPageToken: `p${end}` } : {}),
        },
      };
    };
  }

  async function everyPage(name: string, args: Record<string, unknown>): Promise<any[]> {
    const connector = connection();
    const pages: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(connector, name, { ...args, ...(cursor ? { cursor } : {}) });
      // The complete result, cursor included, inside the shared budget — and
      // so inside the bridge, envelope and all.
      expect(jsonBytes(page)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
      expect(bridged(page)).toBeLessThan(BRIDGE_BYTES);
      await conforms(connector, name, page);
      pages.push(page);
      cursor = page.page.nextCursor ?? undefined;
      expect(pages.length).toBeLessThan(500);
    } while (cursor);
    return pages;
  }

  // Each mid-page continuation re-reads Google's whole page, so the largest
  // page's fixture stays under the listing cut to keep that re-reading cheap
  // under workerd on a loaded machine; the default page covers the cut.
  it.each([
    ["the default page", {}, 25, 30, 2_500],
    ["the largest page", { limit: 100 }, 100, 6, 1_500],
  ])("ends %s early and continues by cursor, losing and repeating nothing", { timeout: 30_000 }, async (_label, extra, count, questions, chars) => {
    route = serve(paragraphForm(questions), responses(count, questions, long(chars)));
    const pages = await everyPage("list_responses", { formId: "big", ...extra });
    const seen = pages.flatMap((page) => page.responses.map((response: any) => response.responseId));
    expect(seen).toEqual(Array.from({ length: count }, (_, index) => `r${index}`));
    // Ended early: more pages than Google's one, each cut answer marked.
    expect(pages.length).toBeGreaterThan(1);
    const answer = pages[0].responses[0].answers[0].values[0] as string;
    if (chars > 2_000) expect(answer).toContain("more characters truncated; get_response reads it whole");
    else expect(answer).toBe(long(chars));
  });

  it("narrows one response too large for a page, naming the answers it left out", async () => {
    const form = paragraphForm(400);
    const [giant] = responses(1, 400);
    route = serve(form, [giant]);
    const connector = connection();
    const listed = await call(connector, "list_responses", { formId: "big" });
    expect(jsonBytes(listed)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(bridged(listed)).toBeLessThan(BRIDGE_BYTES);
    await conforms(connector, "list_responses", listed);
    const row = listed.responses[0];
    expect(row.answers.length + row.omittedQuestionIds.length).toBe(400);
    expect(row.omittedQuestionIds[0]).toBe(`q${row.answers.length}`);

    route = (request) => (request.url.pathname.includes("/responses/") ? { body: giant } : { body: form });
    const whole = await call(connector, "get_response", { formId: "big", responseId: "r0" });
    expect(jsonBytes(whole)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(bridged(whole)).toBeLessThan(BRIDGE_BYTES);
    await conforms(connector, "get_response", whole);
    expect(whole.omittedQuestionIds.length).toBeGreaterThan(0);
    // The omitted ids read back whole, a few at a time.
    const some = whole.omittedQuestionIds.slice(0, 10);
    const narrowed = await call(connection(), "get_response", { formId: "big", responseId: "r0", questionIds: some });
    expect(bridged(narrowed)).toBeLessThan(BRIDGE_BYTES);
    expect(narrowed.answers.map((answer: any) => answer.questionId)).toEqual(some);
    expect(narrowed.answers[0].values[0]).toBe(LONG);
    expect(narrowed.omittedQuestionIds).toBeUndefined();
  });

  it("pages a large form's items, and refuses a cursor once the form has changed", async () => {
    const options = Array.from({ length: 150 }, (_, index) => ({ value: `${index} ${"選".repeat(400)}` }));
    const form = {
      formId: "huge",
      revisionId: "00000009",
      info: { title: "Huge", description: "説".repeat(3_000) },
      items: [
        ...Array.from({ length: 25 }, (_, index) => ({
          itemId: `i${index}`,
          title: "問".repeat(3_000),
          description: "述".repeat(3_000),
          questionItem: { question: { questionId: `q${index}`, choiceQuestion: { type: "DROP_DOWN", options } } },
        })),
        {
          itemId: "grid",
          title: "Grid",
          questionGroupItem: {
            grid: { columns: { type: "RADIO", options: options.slice(0, 5) } },
            questions: Array.from({ length: 2_000 }, (_, index) => ({
              questionId: `row${index}`,
              rowQuestion: { title: "列".repeat(150) },
            })),
          },
        },
      ],
    };
    route = () => ({ body: form });
    const pages = await everyPage("get_form", { formId: "huge" });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.items.map((item: any) => item.itemId))).toEqual([
      ...Array.from({ length: 25 }, (_, index) => `i${index}`),
      "grid",
    ]);
    expect(pages.every((page) => page.itemCount === 26)).toBe(true);
    // everyPage ran each page, this trimmed grid's moreQuestions included,
    // through schema validation and the undeclared-key walk.
    const grid = pages.at(-1).items.at(-1);
    expect(grid.questions.length + grid.moreQuestions).toBe(2_000);
    expect(grid.questions.length).toBeGreaterThan(0);

    // The same form whole is more than one result: raw refuses with guidance.
    const raw = await call(connection(), "get_form", { formId: "huge", raw: true }).catch((error) => error);
    expect(raw).toMatchObject({ code: "invalid_args", message: expect.stringContaining("pages its items") });

    // Items are addressed by index; a page of a changed form would skip some.
    const first = await call(connection(), "get_form", { formId: "huge" });
    route = () => ({ body: { ...form, revisionId: "00000010" } });
    await expect(
      call(connection(), "get_form", { formId: "huge", cursor: first.page.nextCursor }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      call(connection(), "get_form", { formId: "other", cursor: first.page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("bounds escaped control characters and an oversized header, measuring the whole result", async () => {
    // Each U+0001 is one character and six bytes of JSON (\u0001), so a
    // character cut alone would let text grow six-fold past its place.
    const control = (chars: number) => "\u0001".repeat(chars);
    const options = Array.from({ length: 100 }, () => ({ value: control(400) }));
    const form = {
      formId: "escaped",
      revisionId: "00000003",
      info: { title: control(5_000), documentTitle: control(5_000), description: control(5_000) },
      items: [
        ...Array.from({ length: 12 }, (_, index) => ({
          itemId: `i${index}`,
          title: control(5_000),
          description: control(5_000),
          questionItem: { question: { questionId: `q${index}`, choiceQuestion: { type: "CHECKBOX", options } } },
        })),
        {
          itemId: "grid",
          title: control(5_000),
          questionGroupItem: {
            grid: { columns: { type: "CHECKBOX", options } },
            questions: Array.from({ length: 1_000 }, (_, index) => ({
              questionId: `row${index}`,
              rowQuestion: { title: control(400) },
            })),
          },
        },
      ],
    };
    route = () => ({ body: form });
    const pages = await everyPage("get_form", { formId: "escaped" });
    expect(pages.flatMap((page) => page.items.map((item: any) => item.itemId))).toEqual([
      ...Array.from({ length: 12 }, (_, index) => `i${index}`),
      "grid",
    ]);
    const header = pages[0];
    for (const field of ["title", "documentTitle", "description"]) {
      expect(jsonBytes(header[field])).toBeLessThanOrEqual(8 * 1024);
      expect(header[field]).toMatch(/more characters truncated; pass raw: true to read it\]$/);
    }
    expect(jsonBytes(pages[0].items[0].questions[0].options[0])).toBeLessThanOrEqual(1024);
  });
});

describe("list_responses resumes only on the page it was issued for", () => {
  /** Twelve long answers each: two responses fill a page, a third does not. */
  const form = {
    formId: "f",
    revisionId: "1",
    info: { title: "Retreat" },
    items: Array.from({ length: 12 }, (_, index) => ({
      itemId: `i${index}`,
      title: `Q${index}`,
      questionItem: { question: { questionId: `q${index}`, textQuestion: { paragraph: true } } },
    })),
  };
  const response = (id: string) => ({
    responseId: id,
    answers: Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `q${index}`,
        { questionId: `q${index}`, textAnswers: { answers: [{ value: "日".repeat(2_500) }] } },
      ]),
    ),
  });
  const ids = (page: any) => page.responses.map((entry: any) => entry.responseId);

  /** Rows the responses route serves, read afresh on every list call. */
  let rows: string[] | (() => string[]) = [];
  beforeEach(() => {
    route = (request) =>
      request.url.pathname.endsWith("/responses")
        ? { body: { responses: (typeof rows === "function" ? rows() : rows).map(response) } }
        : { body: form };
  });

  it("continues strictly after the last response when the page is unchanged", async () => {
    rows = ["r0", "r1", "r2", "r3", "r4"];
    const connector = connection();
    const first = await call(connector, "list_responses", { formId: "f" });
    expect(ids(first)).toEqual(["r0", "r1"]);
    expect(jsonBytes(first)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    calls.length = 0;
    const second = await call(connector, "list_responses", { formId: "f", cursor: first.page.nextCursor });
    expect(ids(second)).toEqual(["r2", "r3"]);
    // The same Google page, re-read at the same size, with no token.
    const list = calls.find((entry) => entry.url.pathname.endsWith("/responses"))!;
    expect(Object.fromEntries(list.url.searchParams)).toEqual({ pageSize: "25" });
    const third = await call(connector, "list_responses", { formId: "f", cursor: second.page.nextCursor });
    expect(ids(third)).toEqual(["r4"]);
    expect(third.page).toEqual({ hasMore: false, nextCursor: null });
  });

  it.each([
    // Google promises no stable order: the anchor alone would continue after
    // r1 here and return r0 again while skipping r2.
    ["reordered", ["r2", "r1", "r0", "r3", "r4"]],
    ["a submission inserted before the anchor", ["new", "r0", "r1", "r2", "r3", "r4"]],
    ["a submission inserted after the anchor", ["r0", "r1", "new", "r2", "r3", "r4"]],
    ["shorter, the tail gone", ["r0", "r1", "r2"]],
    ["the anchor deleted", ["r0", "r2", "r3", "r4"]],
  ])("refuses a page that came back %s, with restart guidance", async (_case, refetched) => {
    rows = ["r0", "r1", "r2", "r3", "r4"];
    const connector = connection();
    const first = await call(connector, "list_responses", { formId: "f" });
    rows = refetched;
    const failure = await call(connector, "list_responses", { formId: "f", cursor: first.page.nextCursor }).catch(
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "conflict", retryable: false });
    expect(failure.message).toContain("Start again without cursor");
    expect(failure.message).toContain("submittedAfter");
  });

  it("ends an order that alternates between reads with conflict, never a cycle", async () => {
    let reads = 0;
    rows = () => (reads++ % 2 === 0 ? ["r0", "r1", "r2", "r3", "r4"] : ["r1", "r0", "r3", "r2", "r4"]);
    const connector = connection();
    let cursor: string | undefined;
    let failure: any;
    for (let page = 0; page < 10 && failure === undefined; page += 1) {
      try {
        const result = await call(connector, "list_responses", { formId: "f", ...(cursor ? { cursor } : {}) });
        cursor = result.page.nextCursor ?? undefined;
        if (!cursor) break;
      } catch (error) {
        failure = error;
      }
    }
    expect(failure).toMatchObject({ code: "conflict" });
    expect(reads).toBe(2);
  });

  it("moves to Google's next page once the anchored page is spent", async () => {
    const pages: Record<string, { responses: unknown[]; nextPageToken?: string }> = {
      "": { responses: ["r0", "r1", "r2"].map(response), nextPageToken: "g2" },
      g2: { responses: ["r3"].map(response) },
    };
    route = (request) =>
      request.url.pathname.endsWith("/responses")
        ? { body: pages[request.url.searchParams.get("pageToken") ?? ""] }
        : { body: form };
    const connector = connection();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(connector, "list_responses", { formId: "f", ...(cursor ? { cursor } : {}) });
      seen.push(...ids(page));
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["r0", "r1", "r2", "r3"]);
  });
});
