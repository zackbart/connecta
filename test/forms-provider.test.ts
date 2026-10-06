// The Google Forms connection. Tests stub the network and pin the requests
// each tool sends, the projections it returns, and the surface it refuses to
// have — H1, H9, H10, H11, and H14 for this provider. Delegation, subjects,
// and tokens are test/google-workspace-delegation.test.ts; one fail-closed
// case is repeated here so this connection is seen to inherit them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCaller } from "../src/connector-caller.js";
import { FORMS_API_BASE_URL, FORMS_SCOPES, forms } from "../src/providers/forms.js";
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
    q2: { questionId: "q2", textAnswers: { answers: [{ value: "x".repeat(2_500) }] } },
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
      questionCount: 6,
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
      cursor: "page-1",
    });

    const list = calls.find((entry) => entry.url.pathname.endsWith("/responses"))!;
    expect(list.method).toBe("GET");
    expect(list.url.pathname).toBe("/v1/forms/form-1/responses");
    expect(Object.fromEntries(list.url.searchParams)).toEqual({
      filter: "timestamp > 2026-09-30T00:00:00Z",
      pageSize: "5",
      pageToken: "page-1",
    });
    expect(calls.map((entry) => `${entry.method} ${entry.url.pathname}`).sort()).toEqual([
      "GET /v1/forms/form-1",
      "GET /v1/forms/form-1/responses",
    ]);

    expect(result.formId).toBe("form-1");
    expect(result.page).toEqual({ hasMore: true, nextCursor: "page-2" });
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
      `${"x".repeat(2_000)}\n[… 500 more characters truncated; get_response returns it whole]`,
    );
    expect(response.answers[2].values).toEqual(["Fri", "Sat"]);
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
    expect(result.formId).toBeUndefined();
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

describe("errors (H11)", () => {
  it("never calls a 404 absent: a form is a Drive file the user may not see", async () => {
    route = () => ({ status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } });
    const failure = await call(connection(), "get_form", { formId: "hidden" }).catch((error) => error);
    expect(failure.code).toBe("connector_call_failed");
    expect(failure.code).not.toBe("not_found");
    expect(failure.message).toContain("not visible to this account");
  });

  it("maps a stale revision to invalid_args, so the caller re-reads rather than retries", async () => {
    route = () => ({
      status: 400,
      body: { error: { code: 400, message: "The required revision ID 00000041 does not match the latest revision.", status: "INVALID_ARGUMENT" } },
    });
    await expect(
      call(connection(), "batch_update_form", {
        formId: "form-1",
        requests: [{ deleteItem: { location: { index: 0 } } }],
        requiredRevisionId: "00000041",
      }),
    ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("required revision") });
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
