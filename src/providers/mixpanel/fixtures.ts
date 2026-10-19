import hostedSchemas from "./hosted-schemas.fixture.json";
import type { ToolDef } from "../../types.js";
import { mixpanel } from "./index.js";
const options: Parameters<typeof mixpanel>[1] = { purpose: "Audit fixture", via: "api", auth: { type: "credential" } };
export const fixture = {
  name: "mixpanel",
  options,
  cases: [
    { label: "padded-purpose", options: { purpose: "  Audit fixture  " } },
    { label: "default", options: {} },
    { label: "mcp", options: { via: "mcp", auth: { type: "oauth" } } },
    { label: "eu", options: { region: "eu" } },
    { label: "in", options: { region: "in" } },
  ],
  create(id = "fixture", overrides: Partial<Parameters<typeof mixpanel>[1]> = {}) { return mixpanel(id, { ...options, ...overrides } as Parameters<typeof mixpanel>[1]); },
  conventions: { verbs: ["mixpanel", "list", "export", "get", "query", "import"], nestedDescriptionExceptions: [], auth: "credential" },
};

// Credential-free examples copied/adapted from the official reference pages in drift.json.
export const responses = {
  // /api/app/me has no documented response schema. This is an opaque metadata
  // stand-in, not a claim about its fields; the tool does not parse projects.
  account: { metadata: "Service account fixture; project ids are opaque vendor metadata" },
  activity: { status: "ok", results: { events: [
    { event: "Viewed Page", properties: { time: 1599589470, distinct_id: "fixture-user", $browser: "Chrome", report_name: "funnels" } },
    { event: "Game Played", properties: { time: 1599589453, $distinct_id: "fixture-user", $browser: "Chrome", report_name: "insights" } },
  ] } },
  profiles: { page: 0, page_size: 1, results: [{ $distinct_id: "13793", $properties: { $email: "example@mixpanel.com", $first_name: "Example" } }], session_id: "1234567890-EXAMPL", status: "ok", total: 2 },
  insights: { computed_at: "2020-09-21T16:35:41.252314+00:00", date_range: { from_date: "2020-08-31T00:00:00-07:00", to_date: "2020-09-12T23:59:59.999000-07:00" }, headers: ["$event"], series: { "Logged in": { "2020-08-31T00:00:00-07:00": 9852 } } },
  funnel: { meta: { dates: ["2020-09-02"] }, data: { "2020-09-02": { steps: [{ count: 100, event: "Viewed page", overall_conv_ratio: 1, step_conv_ratio: 1 }] } } },
  retention: { "2012-01-01": { counts: [2, 1, 2], first: 2 } },
  imported: { code: 200, num_records_imported: 1, status: "OK" },
  export: '{"event":"Signed up","properties":{"time":1602611311,"$insert_id":"hpuDqcvpltpCjBsebtxwadtEBDnFAdycabFb","mp_processing_time_ms":1602625711874}}\n',
  event: { event: "Signup", properties: { time: 1618716477000, distinct_id: "91304156-cafc-4673-a237-623d1129c801", $insert_id: "29fc2962-6d9c-455d-95ad-95b84f09b9e4", "Referred by": "Friend" } },
};

// Full live JSON describe schemas reviewed on 2026-10-19. No served annotations:
// Connecta synthesizes readOnlyHint:false for stale digests. Tests supply raw
// hint scenarios explicitly rather than mistaking those served hints for upstream.
export const hostedSchemaFixtures: ToolDef[] = hostedSchemas;
