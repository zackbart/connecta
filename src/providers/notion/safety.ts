// Notion's reviewed value-safety table (#801), on the shared mechanism in
// `../_shared/rest/value-safety.ts`: every operation the detector flags in
// the pinned spec (`evidence/value-safety.json`) has one verdict here, and
// `provider.safety.node.test.ts` runs the shared harness over it.
//
// Notion's API returns little that is a credential: an integration token
// never appears in a response. The OAuth endpoints mint, introspect, and
// revoke tokens with a public integration's client secret and are refused.
// A file upload's `upload_url` is Notion's own send endpoint and needs the
// integration token, so it is kept. Notion-minted file URLs are pre-signed:
// sanitizeLinks removes their whole query/fragment wherever they appear,
// including page Markdown and free-form async results, before projections
// or the shared whole-URL heuristic. The same scan precedes error mapping.
import {
  refuse,
  safe,
  withholdSignedLinksIn,
  type FileHosts,
  type ValueSafetyTable,
  type ValueSafetyVerdict,
} from "../_shared/rest/value-safety.js";

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

/**
 * Where Notion stores the files it signs. Its S3 buckets, virtual-hosted
 * (`prod-files-secure.s3.us-west-2.amazonaws.com`) or as the first path
 * segment on an S3 endpoint (`s3.us-west-2.amazonaws.com/secure.notion-static.com/…`,
 * Notion's file object reference), and its own file, static, and image-proxy
 * hosts and their subdomains (`file.notion.so`, `img.notionusercontent.com`).
 * Never all of `amazonaws.com`, and never a host or path that merely
 * contains one of these names: a person's link is their content.
 */
export const NOTION_FILE_HOSTS: FileHosts = {
  domains: ["file.notion.so", "secure.notion-static.com", "notionusercontent.com"],
  buckets: ["prod-files-secure", "secure.notion-static.com"],
};

/**
 * Every response with each pre-signed file link embedded in its strings
 * withheld. Images in page Markdown render as `![caption](url)` and files,
 * PDFs, audio, and video as `<file src="url">`, so a Notion-hosted file's
 * pre-signed URL arrives inside text rather than as a field: in `GET` and
 * `PATCH /v1/pages/{page_id}/markdown`, and in a completed async task's
 * `result`, which is free-form. Every response and error body is scanned
 * rather than those paths, so no route to page Markdown can skip it.
 */
export function sanitizeLinks(body: unknown): unknown {
  return withholdSignedLinksIn(body, NOTION_FILE_HOSTS);
}
