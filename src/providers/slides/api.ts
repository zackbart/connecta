// Slides' five API methods and explicit reviewed hatch admission. Delegation,
// transport and standard Google failures remain in the shared kit.
import { Effect, Schema } from "effect";
import { get, post, vendor, type Connection, type ConnectOptions } from "../../http/vendor.js";
import { googleErrors, googleSafety, type GoogleProduct, type GoogleFacts } from "../_shared/google/kit.js";
import type { VendorErrors } from "../../http/errors.js";
import type { HatchBinding, HatchDeclaration } from "../../http/hatch.js";
import { RequestSecrets } from "../../runtime/call.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { googleHatchBinding, googleBatchGuard } from "../_shared/google/hatch.js";
import { openapi } from "./openapi.generated.js";
import { REQUEST_KINDS, COMMENT_KINDS, COMMENTS_UNSAVED } from "./lib/requests.js";
import { SLIDES_SCOPES } from "./lib/constants.js";

export const SLIDES: GoogleProduct = {
  provider: "Google Slides",
  api: "Google Slides API",
  scopes: SLIDES_SCOPES,
  // A deck is a Drive file: 404 cannot distinguish absence from lack of access.
  notFound: "ambiguous",
};

const PresentationId = { presentationId: Schema.String };
const PageId = { ...PresentationId, pageObjectId: Schema.String };
const ReadQuery = {
  fields: Schema.optionalKey(Schema.String),
  commentsViewMode: Schema.optionalKey(Schema.String),
};

// Discovery calls this one parameter `presentationsId` (plural).
export const getPresentation = get("getPresentation", "/presentations/:presentationsId", {
  params: { presentationsId: Schema.String },
  query: ReadQuery,
  success: Schema.Unknown,
});

const OPERATIONS = [
  getPresentation,
  get("getPage", "/presentations/:presentationId/pages/:pageObjectId", {
    params: PageId,
    query: ReadQuery,
    success: Schema.Unknown,
  }),
  get("getThumbnail", "/presentations/:presentationId/pages/:pageObjectId/thumbnail", {
    params: PageId,
    query: {
      "thumbnailProperties.mimeType": Schema.optionalKey(Schema.String),
      "thumbnailProperties.thumbnailSize": Schema.optionalKey(Schema.String),
    },
    success: Schema.Unknown,
  }),
  post("createPresentation", "/presentations", { payload: Schema.Unknown, success: Schema.Unknown }),
  post("batchUpdate", "/presentations/:presentationId:batchUpdate", {
    params: PresentationId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
] as const;

export const SlidesApi = vendor({ name: "Google Slides", manifestBase: "/v1" }, ...OPERATIONS);
const standardErrors = googleErrors(SLIDES, { standard: true, revisionConflicts: true });
export const errors: VendorErrors<GoogleFacts> = {
  ...standardErrors,
  meanings: {
    ...standardErrors.meanings!,
    conflicts: [
      ...standardErrors.meanings!.conflicts.map((meaning) => meaning.replace(/\.$/, "")),
      "The content or revision bound to a named continuation cursor changed; restart the read",
    ],
  },
};
export const safety = googleSafety(SLIDES.provider, OPERATIONS);

// Delegation has no operator credential to test, so this probe is never run.
export const probe = {
  operation: getPresentation,
  request: { params: { presentationsId: "-" } },
  describe: () => "Google Slides delegation has no credential to test.",
};

// Full frozen inventory; execution is the literal reviewed subset below.
export const SLIDES_INDEX = new OperationIndex(openapi, {
  vendor: "slides",
  title: "Google Slides",
  pathMatching: "uri-template",
});
export const SLIDES_VERDICTS = {
  "GET /presentations/{presentationsId}": "read",
  "GET /presentations/{presentationId}/pages/{pageObjectId}": "read",
  "GET /presentations/{presentationId}/pages/{pageObjectId}/thumbnail": "refuse",
  "POST /presentations": "write",
  "POST /presentations/{presentationId}:batchUpdate": "destructive",
} as const satisfies HatchDeclaration["verdicts"];
export const SLIDES_NAMED = {
  "GET /presentations/{presentationsId}": "get_presentation",
  "GET /presentations/{presentationId}/pages/{pageObjectId}": "get_page",
  "GET /presentations/{presentationId}/pages/{pageObjectId}/thumbnail": "get_slide_thumbnail",
  "POST /presentations": "create_presentation",
  "POST /presentations/{presentationId}:batchUpdate": "batch_update_presentation",
} as const satisfies HatchDeclaration["named"];

export function slidesBinding(connection: Connection): HatchBinding {
  return googleHatchBinding(connection, {
    index: SLIDES_INDEX,
    review:
      "Four reviewed Slides JSON routes; thumbnails mint a temporary capability and remain named-only. Batch requests retain the 49 shipped kinds and revision precondition. No new preview methods.",
    refuse: (call) =>
      call.op.path.endsWith("/thumbnail")
        ? "Generic Slides thumbnail/preview links are refused; use get_slide_thumbnail for the reviewed short-lived link."
        : call.op.path.endsWith(":batchUpdate")
          ? googleBatchGuard(call.body, { kinds: REQUEST_KINDS, revision: true, max: 100 })
          : undefined,
    revisionGuarded: (call) => call.op.path.endsWith(":batchUpdate"),
    wrapSend: (call, send) =>
      send().pipe(
        Effect.map((answer) => {
          if (!call.op.path.endsWith(":batchUpdate")) return answer;
          const body = call.body as { requests?: Record<string, unknown>[] };
          const data = answer.data && typeof answer.data === "object" ? (answer.data as Record<string, unknown>) : {};
          const comments = body.requests?.some((request) =>
            Object.keys(request).some((kind) => COMMENT_KINDS.has(kind)),
          );
          const state = data["commentUpdateState"];
          if (
            (comments && state !== "ALL_SAVED") ||
            (state !== undefined && !["ALL_SAVED", "NO_UPDATES_REQUESTED"].includes(String(state)))
          )
            return {
              ...answer,
              warnings: [
                `commentUpdateState: ${state === undefined ? "not reported" : String(state)}. ${COMMENTS_UNSAVED}`,
              ],
            };
          return answer;
        }),
      ),
  });
}

/** Guard rich-text lanes before styles can separate adjacent fragments of a sent secret. */
export const result: NonNullable<ConnectOptions["result"]> = (body, answer) =>
  Effect.gen(function* () {
    const secrets = yield* RequestSecrets;
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (!answer.operation.template.endsWith("/thumbnail") && typeof record["contentUrl"] === "string")
        record["contentUrl"] = "[redacted]";
      const elements = record["textElements"];
      if (Array.isArray(elements)) {
        const runs = elements.map((element) => element?.textRun ?? element?.autoText ?? {});
        const safe = secrets.parts(runs.map((run) => (typeof run.content === "string" ? run.content : "")));
        runs.forEach((run, index) => {
          if (typeof run.content === "string") run.content = safe[index];
        });
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(body);
    return body;
  });
