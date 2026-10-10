// Notion's reviewed value-safety table (#801), on the shared mechanism in
// `../_shared/rest/value-safety.ts`: every operation the detector flags in
// the pinned spec (`value-safety.candidates.json`) has one verdict here, and
// `value-safety.node.test.ts` runs the shared harness over it.
//
// Notion's API returns little that is a credential: an integration token
// never appears in a response. The OAuth endpoints mint, introspect, and
// revoke tokens with a public integration's client secret and are refused.
// A file upload's `upload_url` is Notion's own send endpoint and needs the
// integration token, so it is kept. Notion-hosted file URLs in pages and
// blocks are pre-signed: the shared URL rule withholds their signature,
// credential, and security-token query parameters on every response, so a
// returned URL names the file without granting access to it.
import { refuse, safe, type ValueSafetyTable, type ValueSafetyVerdict } from "../_shared/rest/value-safety.js";

const OAUTH =
  "Notion's OAuth token endpoints are not reachable through Connecta: they mint and revoke credentials with a public integration's client secret, which this connector never holds.";
const UPLOAD =
  "A file upload's upload_url is Notion's own send endpoint, which needs the integration token; it grants nothing alone.";
const AGENT = "Custom agents name their connected MCP server's host, never its URL or credentials.";

const OPERATIONS: Readonly<Record<string, ValueSafetyVerdict>> = {
  "POST /v1/oauth/token": refuse(OAUTH),
  "POST /v1/oauth/introspect": refuse(OAUTH),
  "POST /v1/oauth/revoke": refuse(OAUTH),
  "GET /v1/users/me": safe("Answers the integration's bot user; no token."),
  "GET /v1/file_uploads": safe(UPLOAD, ["results.upload_url"]),
  "POST /v1/file_uploads": safe(UPLOAD, ["upload_url"]),
  "GET /v1/file_uploads/{file_upload_id}": safe(UPLOAD, ["upload_url"]),
  "POST /v1/file_uploads/{file_upload_id}/complete": safe(UPLOAD, ["upload_url"]),
  "POST /v1/file_uploads/{file_upload_id}/send": safe(UPLOAD, ["upload_url"]),
  "POST /v1/agents/query": safe(AGENT, ["results.connections.account.server_host"]),
  "GET /v1/agents/{agent_id}": safe(AGENT, ["connections.account.server_host"]),
};

export const NOTION_VALUE_SAFETY: ValueSafetyTable = { title: "Notion", operations: OPERATIONS };
