import type { OpenApiData } from "../../_shared/rest/operation-index.js";

// Reviewed workflow synonyms supplement, rather than replace, every pinned action/resource word.
const summaries: Readonly<Record<string, string>> = {
  "GET /zones": "Find domains and zones by name or account",
  "GET /zones/{zone_id}": "Get zone details and domain configuration",
  "GET /accounts/{account_id}/r2/buckets": "List R2 buckets for an account",
  "PATCH /zones/{zone_id}/dns_records/{dns_record_id}": "Update DNS record: set DNS TTL, content, name or proxy status",
  "POST /zones/{zone_id}/purge_cache": "Clear cache for a file or URL: purge cache files, tags, hosts or prefixes",
  "PUT /accounts/{account_id}/workers/scripts/{script_name}": "Deploy a Worker script: upload source and bindings",
  "GET /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/keys":
    "List KV keys and expiration metadata by prefix",
};
export function cloudflareDiscovery(data: OpenApiData): OpenApiData {
  const tags = [...data.tags];
  return {
    ...data,
    tags,
    ops: data.ops.map(([method, path, id, summary, tag, server]) => {
      const reviewed = summaries[`${method} ${path}`];
      const combined = reviewed ? `${reviewed} (${summary})` : summary;
      // The vendor calls deployment "upload"; keep that action and add the
      // reviewed deployment category beside the original resource category.
      const category =
        method === "PUT" && path === "/accounts/{account_id}/workers/scripts/{script_name}"
          ? tags.push(`${data.tags[tag]} (Worker deploy)`) - 1
          : tag;
      return server === undefined
        ? [method, path, id, combined, category]
        : [method, path, id, combined, category, server];
    }),
  };
}
