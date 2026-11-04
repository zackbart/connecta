import { hatchDiscovery, type ProviderTable } from "./types.js";

const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";
const READ_RULES =
  "Pass page.nextCursor in page.param within page.in, preserving the other arguments. Text/SQL reads take a string body.";
const WRITE_RULES = "Uploads use cloudflare_api_upload; JSON, text/SQL and NDJSON writes keep their wire formats.";

export const CLOUDFLARE: ProviderTable = {
  tools: {
    list_accounts: {
      terse: "List pinned Cloudflare accounts by name.",
      disambiguation:
        "Resolve a Cloudflare account name to its id for zones, Workers, KV and R2; only pinned accounts.",
      example: 'List pinned Cloudflare accounts. Example: {"name":"Account A","fields":["id","name"]}.',
    },
    list_zones: {
      terse: "List pinned Cloudflare zones by name, status or account.",
      disambiguation: "Resolve a domain to its zone and account ids for DNS, cache and analytics; only pinned zones.",
      example: 'List pinned Cloudflare zones. Example: {"name":"example.com","fields":["id","name","accountId"]}.',
    },
    verify_credential: {
      terse: "Verify the Cloudflare credential. Call it first when another call fails with auth_required.",
      disambiguation: "Verify the Cloudflare credential. Call it first when another call fails with auth_required.",
      example: "Verify the Cloudflare credential; call it first after auth_required. Example: {}.",
    },
    graphql_query: {
      terse:
        "Run a read-only GraphQL Analytics query filtered by zoneTag or accountTag. Mutations and subscriptions are refused.",
      disambiguation:
        "Read Cloudflare analytics with GraphQL, filtered by zoneTag or accountTag; cloudflare_api_read reads REST resources. Mutations and subscriptions are refused.",
      example:
        'Run a read-only GraphQL Analytics query; mutations and subscriptions are refused. Example: {"query":"query($z:String!){viewer{zones(filter:{zoneTag:$z}){httpRequests1dGroups(limit:1,filter:{date:\\"2026-10-01\\"}){sum{requests cachedBytes}}}}}","variables":{"z":"' +
        ZONE +
        '"}}.',
    },
    cloudflare_api_upload: {
      terse: "Upload text, base64 or multipart bytes to a reviewed Cloudflare operation; never reads local files.",
      disambiguation:
        "Upload Workers scripts, KV values, R2 objects, Pages, Images, Stream, DNS import and Snippets; cloudflare_api_write sends other writes. Never reads local files.",
      example: `Upload to a reviewed Cloudflare operation; never reads local files. Example: {"method":"PUT","path":"/accounts/${ZONE}/storage/kv/namespaces/${ZONE}/values/cache%2Fkey","textBody":"hello"}.`,
    },
    ...hatchDiscovery(
      "Cloudflare",
      '{"query":"dns records","method":"GET"}',
      '{"method":"GET","path":"/zones/{zone_id}/dns_records"}',
      "cloudflare",
    ),
    cloudflare_api_read: {
      terse: `Read a reviewed Cloudflare API operation. Data retains the Cloudflare envelope; use fields:["result.id"]. ${READ_RULES}`,
      disambiguation: `Read DNS records, Workers scripts, R2 and KV after cloudflare_api_search finds the path; list_zones and list_accounts resolve ids. Data retains the Cloudflare envelope; use fields:["result.id"]. ${READ_RULES}`,
      example: `Read a reviewed Cloudflare API operation. Example: {"path":"/zones/${ZONE}/dns_records","query":{"type":"A","name":"api.example.com"},"fields":["result.id","result.content"]}. Data retains the Cloudflare envelope. ${READ_RULES}`,
    },
    cloudflare_api_write: {
      terse: `Send a reviewed Cloudflare API write. ${WRITE_RULES}`,
      disambiguation: `Create, update or delete DNS records, purge cache or change KV/R2 state through an operation cloudflare_api_search found. ${WRITE_RULES}`,
      example: `Send a reviewed Cloudflare API write. Example: {"method":"POST","path":"/zones/${ZONE}/purge_cache","body":{"files":["https://example.com/app.js"]}}. ${WRITE_RULES}`,
    },
  },
};
