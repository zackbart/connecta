import { cloudflare } from "../../../src/providers/cloudflare/index.js";
import { defineGoldenSpec } from "../harness.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";

const envelope = (result: unknown, extra: Record<string, unknown> = {}) => ({
  body: { success: true, errors: [], messages: [], result, ...extra },
});

const ZONE_RECORD = {
  id: ZONE,
  name: "example.com",
  status: "active",
  paused: false,
  type: "full",
  account: { id: ACCOUNT, name: "Alice's Account" },
  name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
  plan: { id: "free", name: "Free Website" },
};

export default defineGoldenSpec({
  provider: "cloudflare",
  create: () => cloudflare("cf", { purpose: "Production DNS and Workers", auth: { type: "apiToken" } }),
  credential: "gC7k9Qx2Vm4Lp8/123+456=",
  failureReply: (status, message) => ({
    status,
    headers: { "cf-ray": "8abc-golden" },
    body: {
      success: false,
      errors: [{ code: 10000 + status, message: `${message}.` }],
      messages: [],
      result: null,
    },
  }),
  calls: [
    { tool: "cloudflare_api_search", args: { query: "dns records", method: "PATCH", limit: 2 } },
    { tool: "cloudflare_api_details", args: { method: "GET", path: `/zones/${ZONE}/dns_records`, param: "type" } },
    {
      tool: "cloudflare_api_read",
      args: {
        path: `/zones/${ZONE}/dns_records`,
        query: { type: "A", per_page: 2 },
        fields: ["result.id", "result.ttl"],
      },
      replies: [
        envelope(
          [
            { id: "r1", name: "a.example.com", type: "A", ttl: 1, content: "192.0.2.1" },
            { id: "r2", name: "b.example.com", type: "A", ttl: 300, content: "192.0.2.2" },
          ],
          { result_info: { page: 1, per_page: 2, count: 2, total_count: 5, total_pages: 3 } },
        ),
      ],
    },
    {
      tool: "cloudflare_api_write",
      args: { method: "PATCH", path: `/zones/${ZONE}/dns_records/r1`, body: { ttl: 300 } },
      replies: [envelope({ id: "r1", name: "a.example.com", type: "A", ttl: 300, content: "192.0.2.1" })],
    },
    {
      tool: "verify_credential",
      replies: [envelope({ id: "t1", status: "active", expires_on: "2027-01-01T00:00:00Z" })],
    },
    {
      tool: "list_accounts",
      args: { limit: 5 },
      replies: [
        envelope([{ id: ACCOUNT, name: "Alice's Account", type: "standard", settings: { enforce_twofactor: true } }], {
          result_info: { page: 1, per_page: 5, count: 1, total_count: 1, total_pages: 1 },
        }),
      ],
    },
    {
      tool: "list_zones",
      args: { name: "example.com", status: "active", accountId: ACCOUNT },
      replies: [
        envelope([ZONE_RECORD], { result_info: { page: 1, per_page: 20, count: 1, total_count: 1, total_pages: 1 } }),
      ],
    },
    {
      tool: "graphql_query",
      args: {
        query:
          "query Daily($zone: String!) { viewer { zones(filter: { zoneTag: $zone }) { httpRequests1dGroups(limit: 1) { dimensions { date } sum { requests } } } } }",
        variables: { zone: ZONE },
        operationName: "Daily",
      },
      replies: [
        {
          body: {
            data: {
              viewer: {
                zones: [{ httpRequests1dGroups: [{ dimensions: { date: "2026-01-01" }, sum: { requests: 1234 } }] }],
              },
            },
            errors: null,
          },
        },
      ],
    },
    {
      tool: "cloudflare_api_upload",
      args: {
        method: "PUT",
        path: `/accounts/${ACCOUNT}/workers/scripts/hello`,
        parts: [
          { name: "metadata", text: JSON.stringify({ main_module: "index.js" }), contentType: "application/json" },
          {
            name: "index.js",
            text: "export default { fetch() { return new Response('hi'); } }",
            fileName: "index.js",
            contentType: "application/javascript+module",
          },
        ],
      },
      replies: [envelope({ id: "hello", etag: "etag-1", modified_on: "2026-01-02T03:04:05Z" })],
    },
    {
      label: "cloudflare_api_upload R2 binary",
      tool: "cloudflare_api_upload",
      args: {
        method: "PUT",
        path: `/accounts/${ACCOUNT}/r2/buckets/b1/objects/logs%2F2026%2Fa.txt`,
        base64Body: btoa("hello"),
        contentType: "text/plain",
        headers: { "cf-r2-jurisdiction": "eu" },
      },
      replies: [envelope({ key: "logs/2026/a.txt", size: 5, etag: "5d41402abc4b2a76b9719d911017c592" })],
    },
  ],
  echo: {
    tool: "cloudflare_api_read",
    args: { path: `/zones/${ZONE}` },
    replies: (text) => [envelope({ id: ZONE, name: text })],
  },
  failures: {
    read: { tool: "cloudflare_api_read", args: { path: `/zones/${ZONE}` } },
    write: {
      tool: "cloudflare_api_write",
      args: { method: "PATCH", path: `/zones/${ZONE}/dns_records/r1`, body: { ttl: 300 } },
    },
  },
});
