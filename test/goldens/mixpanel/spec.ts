import { mixpanel } from "../../../src/providers/mixpanel/index.js";
import { defineGoldenSpec } from "../harness.js";

const RANGE = { from_date: "2025-12-01", to_date: "2025-12-31" };

const SERVICE_ACCOUNT_SECRET = "mS4x7Qv2Lk9Tz3/123+456=";

const ACCOUNT = {
  status: "ok",
  results: {
    id: 1001,
    username: "golden-service-account",
    projects: { "42": { id: 42, name: "Grace Church app", domain: "mixpanel.com", role: { name: "Analyst" } } },
  },
};

const ACTIVITY = {
  status: "ok",
  results: {
    events: [
      { event: "Viewed Page", properties: { time: 1767225600, distinct_id: "alice", $browser: "Chrome" } },
      { event: "Signed Up", properties: { time: 1767225500, $distinct_id: "alice", $browser: "Chrome" } },
    ],
  },
};

const PROFILES = {
  page: 0,
  page_size: 1,
  results: [{ $distinct_id: "alice", $properties: { $email: "alice@example.com", $first_name: "Alice" } }],
  session_id: "1234567890-EXAMPL",
  status: "ok",
  total: 2,
};

const INSIGHTS = {
  computed_at: "2025-12-31T16:35:41.252314+00:00",
  date_range: { from_date: "2025-12-01T00:00:00-07:00", to_date: "2025-12-31T23:59:59.999000-07:00" },
  headers: ["$event"],
  series: { "Logged in": { "2025-12-01T00:00:00-07:00": 9852 } },
};

const FUNNEL = {
  meta: { dates: ["2025-12-02"] },
  data: {
    "2025-12-02": {
      steps: [
        { count: 100, event: "Viewed page", overall_conv_ratio: 1, step_conv_ratio: 1 },
        { count: 40, event: "Signed Up", overall_conv_ratio: 0.4, step_conv_ratio: 0.4 },
      ],
    },
  },
};

const RETENTION = { "2025-12-01": { counts: [2, 1, 2], first: 2 } };

const EXPORT =
  '{"event":"Signed Up","properties":{"time":1767225500,"distinct_id":"alice","$insert_id":"hpuDqcvpltpCjBsebtxwadtEBDnFAdycabFb","mp_processing_time_ms":1767225511874}}\n' +
  '{"event":"Viewed Page","properties":{"time":1767225600,"distinct_id":"bob","$insert_id":"aGVsbG8td29ybGQtaW5zZXJ0LWlkLTAwMDE","mp_processing_time_ms":1767225611874}}\n';

const EVENT = {
  event: "Signup",
  properties: {
    time: 1767225600,
    distinct_id: "91304156-cafc-4673-a237-623d1129c801",
    $insert_id: "29fc2962-6d9c-455d-95ad-95b84f09b9e4",
    "Referred by": "Friend",
  },
};

export default defineGoldenSpec({
  provider: "mixpanel",
  create: () =>
    mixpanel("analytics", {
      via: "api",
      auth: { type: "credential" },
      purpose: "Product reporting",
      defaultProjectId: 42,
    }),
  credential: `mU6p2Wz8Kd3:${SERVICE_ACCOUNT_SECRET}`,
  // The credential's own password half, so an echo of it alone is a leak too.
  secrets: { secret: SERVICE_ACCOUNT_SECRET },
  failureReply: (status, message) => ({ status, body: { status: "error", error: message } }),
  calls: [
    { tool: "mixpanel_api_search", args: { query: "retention", limit: 3 } },
    { tool: "mixpanel_api_details", args: { method: "GET", path: "/api/query/insights" } },
    {
      tool: "mixpanel_api_read",
      args: { path: "/api/query/insights", project_id: 99, query: { bookmark_id: 7 }, select: ["series"] },
      replies: [{ body: INSIGHTS }],
    },
    { tool: "list_projects", replies: [{ body: ACCOUNT }] },
    {
      tool: "export_events",
      args: { ...RANGE, event: ["Signed Up", "Viewed Page"], time_in_ms: true },
      replies: [{ text: EXPORT, headers: { "content-type": "text/plain" } }],
    },
    {
      tool: "get_profile_activity",
      args: { ...RANGE, distinct_id: "alice", project_id: 99 },
      replies: [{ body: ACTIVITY }],
    },
    {
      tool: "query_profiles",
      args: {
        project_id: 99,
        workspace_id: 3,
        distinct_ids: ["alice"],
        output_properties: ["$email"],
        where: 'properties["$first_name"]=="Alice"',
      },
      replies: [{ body: PROFILES }],
    },
    {
      label: "query_profiles next page",
      tool: "query_profiles",
      args: { page: 1, session_id: "1234567890-EXAMPL" },
      replies: [{ body: { ...PROFILES, page: 1, results: [] } }],
    },
    { tool: "get_insights_report", args: { bookmark_id: 11 }, replies: [{ body: INSIGHTS }] },
    { tool: "get_funnel_report", args: { funnel_id: 12, ...RANGE }, replies: [{ body: FUNNEL }] },
    {
      tool: "query_retention",
      args: { ...RANGE, born_event: "Signup", event: "Purchase", retention_type: "birth", unit: "week" },
      replies: [{ body: RETENTION }],
    },
    {
      tool: "import_events",
      args: { project_id: 99, events: [EVENT] },
      replies: [{ body: { code: 200, num_records_imported: 1, status: "OK" } }],
    },
  ],
  echo: {
    tool: "mixpanel_api_read",
    args: { path: "/api/query/insights", project_id: 99, query: { bookmark_id: 7 } },
    replies: (text) => [{ body: { ...INSIGHTS, title: text } }],
  },
  failures: {
    read: { tool: "get_insights_report", args: { bookmark_id: 11 } },
    write: { tool: "import_events", args: { events: [EVENT] } },
  },
});
