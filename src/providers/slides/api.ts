// Slides' five API methods; the shared Google layer owns delegation, errors
// and value safety. Step 1 preserves the tools' legacy schemas and wire bytes.
import { Schema } from "effect";
import { get, post, vendor } from "../../http/vendor.js";
import { googleErrors, googleSafety, type GoogleProduct } from "../_shared/google/kit.js";
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
export const errors = googleErrors(SLIDES);
export const safety = googleSafety(SLIDES.provider, OPERATIONS);

// Delegation has no operator credential to test, so this probe is never run.
export const probe = {
  operation: getPresentation,
  request: { params: { presentationsId: "-" } },
  describe: () => "Google Slides delegation has no credential to test.",
};
