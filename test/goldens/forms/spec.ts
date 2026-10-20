import { forms } from "../../../src/providers/forms/index.js";
import { defineGoldenSpec, type SeenRequest, type StubResponse } from "../harness.js";

const keys = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
const ACCESS_TOKEN = "golden-forms-access-token-123456";

const FORM = {
  formId: "form-1",
  revisionId: "00000042",
  responderUri: "https://docs.google.com/forms/d/e/1FAIpQ/viewform",
  linkedSheetId: "sheet-9",
  info: { title: "Retreat sign-up", documentTitle: "Retreat sign-up (2026)", description: "Fall retreat." },
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
  respondentEmail: "bob@example.com",
  answers: {
    q2: {
      questionId: "q2",
      textAnswers: { answers: [{ value: "No nuts, please." }] },
      grade: {
        score: 0,
        correct: false,
        feedback: {
          text: "See the allergy guide.",
          material: [{ link: { uri: "https://example.com/allergies", displayText: "Allergy guide" } }],
        },
      },
    },
    q1: { questionId: "q1", textAnswers: { answers: [{ value: "Evening" }] } },
    q5: { questionId: "q5", textAnswers: { answers: [{ value: "Fri" }, { value: "Sat" }] } },
    q9: {
      questionId: "q9",
      fileUploadAnswers: { answers: [{ fileId: "f1", fileName: "waiver.pdf", mimeType: "application/pdf" }] },
    },
  },
};

/** The form read and the responses read run concurrently, so route by path, not by order. */
const byPath =
  (other: StubResponse) =>
  (request: SeenRequest): StubResponse =>
    request.url.pathname === "/v1/forms/form-1" ? { body: FORM } : other;

export default defineGoldenSpec({
  provider: "forms",
  // Delegated tokens are cached per service account for the process, so each
  // scenario names its own account and mints its own token.
  create: (scenario) =>
    forms("forms", {
      purpose: "Event registration",
      serviceAccount: {
        clientEmail: `forms-${scenario}@project.iam.gserviceaccount.com`,
        privateKey: PRIVATE_KEY,
      },
      subject: "alice@example.com",
    }),
  secrets: { privateKey: PRIVATE_KEY, accessToken: ACCESS_TOKEN },
  auxiliary: [
    {
      name: "token",
      match: (request) => request.url.href === "https://oauth2.googleapis.com/token",
      reply: { body: { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" } },
    },
  ],
  failureReply: (status, message) => ({
    status,
    body: { error: { code: status, message, status: "GOLDEN_FAILURE" } },
  }),
  calls: [
    { tool: "get_form", args: { formId: "form-1" }, replies: [{ body: FORM }] },
    {
      tool: "create_form",
      args: { title: "Volunteer roster", documentTitle: "Roster" },
      replies: [
        {
          body: {
            formId: "new-1",
            revisionId: "00000001",
            responderUri: "https://docs.google.com/forms/d/e/1FAIpNew/viewform",
            info: { title: "Volunteer roster", documentTitle: "Roster" },
          },
        },
      ],
    },
    {
      label: "create_form unpublished",
      tool: "create_form",
      args: { title: "Draft survey", unpublished: true },
      replies: [
        {
          body: {
            formId: "new-2",
            revisionId: "00000001",
            responderUri: "https://docs.google.com/forms/d/e/1FAIpDraft/viewform",
            info: { title: "Draft survey", documentTitle: "Draft survey" },
          },
        },
      ],
    },
    {
      tool: "list_responses",
      args: { formId: "form-1", submittedAfter: "2026-09-30T00:00:00Z", limit: 5 },
      replies: byPath({ body: { responses: [RESPONSE], nextPageToken: "page-2" } }),
    },
    {
      tool: "get_response",
      args: { formId: "form-1", responseId: "r1" },
      replies: byPath({
        body: {
          ...RESPONSE,
          formId: "form-1",
          totalScore: 3,
          answers: {
            ...RESPONSE.answers,
            q1: {
              questionId: "q1",
              grade: { score: 3, correct: true },
              textAnswers: { answers: [{ value: "Evening" }] },
            },
          },
        },
      }),
    },
    {
      tool: "update_form_info",
      args: { formId: "form-1", title: "Retreat 2026", description: "Bring a coat.", requiredRevisionId: "00000042" },
      replies: [{ body: { writeControl: { requiredRevisionId: "00000043" }, replies: [{}] } }],
    },
    {
      tool: "batch_update_form",
      args: {
        formId: "form-1",
        requiredRevisionId: "00000043",
        requests: [
          {
            createItem: {
              item: { title: "Phone number", questionItem: { question: { required: true, textQuestion: {} } } },
              location: { index: 0 },
            },
          },
          { deleteItem: { location: { index: 4 } } },
          { updateSettings: { settings: { quizSettings: { isQuiz: true } }, updateMask: "quizSettings.isQuiz" } },
        ],
      },
      replies: [
        {
          body: {
            form: { formId: "form-1" },
            writeControl: { requiredRevisionId: "00000044" },
            replies: [{ createItem: { itemId: "i9", questionId: ["q9"] } }, {}, {}],
          },
        },
      ],
    },
  ],
  unsent: ["privateKey"],
  echo: {
    tool: "get_form",
    args: { formId: "form-1" },
    replies: (text) => [{ body: { ...FORM, info: { ...FORM.info, title: text } } }],
  },
  failures: {
    read: { tool: "get_form", args: { formId: "form-1" } },
    write: {
      tool: "update_form_info",
      args: { formId: "form-1", title: "Retreat 2026", requiredRevisionId: "00000042" },
    },
  },
});
