// Reviewed against archived Forms Discovery revision 20261022.
// Form/response bodies are user data: grading answer keys and respondent email
// remain available. Image.contentUri is a vendor-minted temporary bearer
// destination and is permanently withheld, including in batch.form expansions.
// User-authored sourceUri, responderUri, video URLs and feedback links are
// ordinary references. No generic credential URL-name rule is applied there;
// global signing-name defense still covers free text and error bodies.
import { safe, redact, refuse, vendorErrors, type ValueSafetyTable } from "../_shared/rest/value-safety.js";
const imagePaths = [
  "items[].imageItem.image.contentUri",
  "items[].questionGroupItem.questions[].choiceQuestion.options[].image.contentUri",
  "items[].questionGroupItem.grid.columns.options[].image.contentUri",
  "items[].questionGroupItem.image.contentUri",
  "items[].questionItem.question.choiceQuestion.options[].image.contentUri",
  "items[].questionItem.image.contentUri",
] as const;
export const FORMS_VALUE_SAFETY = {
  title: "Google Forms",
  embeddedUrls: {},
  operations: {
    "GET /forms/{formId}": vendorErrors(
      redact(
        "Temporary image download destinations convey private access; form structure and quiz answer keys remain requested user data.",
        imagePaths,
      ),
    ),
    "POST /forms": vendorErrors(redact("Created forms use the same permanent image destination boundary.", imagePaths)),
    "POST /forms/{formId}:batchUpdate": vendorErrors(
      redact(
        "Expanded batch forms use the same permanent image destination boundary.",
        imagePaths.map((path) => `form.${path}`),
      ),
    ),
    "GET /forms/{formId}/responses": vendorErrors(
      safe(
        "Responses and respondent email are requested user data; nextPageToken is only a continuation, not an authentication credential.",
        ["nextPageToken"],
      ),
    ),
    "POST /forms/{formId}/watches": refuse(
      "Persistent Pub/Sub watch registration requires separate product authorization.",
    ),
    "POST /forms/{formId}:setPublishSettings": refuse(
      "Publishing and response availability changes require separate product authorization.",
    ),
  },
  fields: {
    nextPageToken: {
      verdict: "keep",
      reason: "Opaque Forms pagination metadata, usable only with the delegated grant; not an access credential.",
    },
  },
} as const satisfies ValueSafetyTable;
