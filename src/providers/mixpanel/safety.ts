import { safe, type ValueSafetyTable } from "../_shared/rest/value-safety.js";

/** Reviewed 2026-10-14 against the official schemas and service-account guide. */
export const MIXPANEL_VALUE_SAFETY: ValueSafetyTable = {
  title: "Mixpanel",
  operations: {
    "GET /api/app/me": safe(
      "Account metadata has no documented response schema; redact credential-named fields recursively, including project tokens. No service-account administration endpoints are admitted.",
    ),
    "GET /api/2.0/export": safe(
      "JSONL event names and properties; arbitrary property bags pass through recursive credential and bearer-URL redaction.",
    ),
    "GET /api/query/stream/query": safe(
      "Activity event names and properties; arbitrary property bags pass through recursive credential and bearer-URL redaction.",
    ),
    "POST /api/query/engage": safe(
      "Existing profile ids and properties only; arbitrary property bags pass through recursive credential and bearer-URL redaction.",
    ),
    "GET /api/query/insights": safe(
      "Report headers name breakdown dimensions, not HTTP headers; numeric time series contain no authentication values.",
      ["headers"],
    ),
    "GET /api/query/funnels": safe("Funnel steps and conversion counts, no authentication values."),
    "GET /api/query/funnels/list": safe("Saved funnel names and ids, no authentication values."),
    "GET /api/query/retention": safe("Cohort dates and retention counts, no authentication values."),
    "POST /import": safe(
      "Import status and counts only. Vendor error text is withheld because it may quote submitted properties.",
    ),
  },
};
