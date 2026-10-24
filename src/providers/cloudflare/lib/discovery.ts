import type { OpenApiData } from "../../_shared/rest/operation-index.js";

// Reviewed workflow synonyms supplement, rather than replace, every pinned action/resource word.
const summaries: Readonly<Record<string, string>> = {
  "GET /zones": "Find domains and zones by name or account",
  "GET /accounts/{account_id}/r2/buckets": "List R2 buckets for an account",
  "PATCH /zones/{zone_id}/dns_records/{dns_record_id}": "Update DNS record: set DNS TTL, content, name or proxy status",
  "POST /zones/{zone_id}/purge_cache": "Purge cache URL files, tags, hosts or prefixes",
  "PUT /accounts/{account_id}/workers/scripts/{script_name}": "Deploy Worker script source and bindings",
  "GET /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/keys":
    "List KV keys and expiration metadata by prefix",
};
export function cloudflareDiscovery(data: OpenApiData): OpenApiData {
  return {
    ...data,
    ops: data.ops.map(([method, path, id, summary, tag, server]) => {
      const reviewed = summaries[`${method} ${path}`];
      const combined = reviewed ? `${reviewed} (${summary})` : summary;
      return server === undefined ? [method, path, id, combined, tag] : [method, path, id, combined, tag, server];
    }),
  };
}
