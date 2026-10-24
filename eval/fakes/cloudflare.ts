/** Isolated Cloudflare step-2 fixtures; the historical #801 replies stay unchanged. */
export const CF_NAMESPACE = "7".repeat(32);
const CF_STEP2_ZONE = "1".repeat(32);
export function cloudflareStep2Dns() {
  return Array.from({ length: 137 }, (_, i) => ({
    id: (100 + i).toString(16).padStart(32, "0"),
    zone_id: CF_STEP2_ZONE,
    type: i % 3 === 0 ? "TXT" : "A",
    name: `${i % 3 === 0 ? "audit" : "node"}${i}.example.com`,
    content: i % 3 === 0 ? `ticket-${i}` : `192.0.2.${i + 1}`,
    ttl: 300,
    proxied: false,
  }));
}
export const CF_STEP2_KEYS = [
  { name: "cache:alice", expiration: 1800000100, metadata: { owner: "alice" } },
  { name: "cache:bob", expiration: 1800000200, metadata: { owner: "bob" } },
  { name: "cache:carol", expiration: 1800000300, metadata: { owner: "carol" } },
  { name: "other:decoy", expiration: 1800000400 },
];
export function cloudflareStep2Read(path: string, query: Record<string, string>, dns: Record<string, any>[]) {
  const envelope = (result: unknown, result_info?: unknown) => ({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(result_info ? { result_info } : {}),
  });
  if (path.endsWith("/storage/kv/namespaces"))
    return envelope([
      { id: CF_NAMESPACE, title: "edge-cache" },
      { id: "8".repeat(32), title: "unrelated" },
    ]);
  if (path.endsWith(`/storage/kv/namespaces/${CF_NAMESPACE}/keys`)) {
    const rows = CF_STEP2_KEYS.filter((key) => !query.prefix || key.name.startsWith(query.prefix));
    const at = query.cursor ? Number(query.cursor.replace(/^kv_/, "")) : 0;
    const limit = Math.min(2, Number(query.limit ?? 2));
    const result = rows.slice(at, at + limit);
    return envelope(result, { count: result.length, cursor: at + limit < rows.length ? `kv_${at + limit}` : "" });
  }
  const match = /^\/zones\/([^/]+)\/dns_records$/.exec(path);
  if (match) {
    const rows = dns.filter(
      (r) => r.zone_id === match[1] && (!query.name || r.name === query.name) && (!query.type || r.type === query.type),
    );
    const page = Number(query.page ?? 1),
      per_page = Math.min(50, Number(query.per_page ?? 20));
    const result = rows.slice((page - 1) * per_page, page * per_page);
    return envelope(result, {
      page,
      per_page,
      count: result.length,
      total_count: rows.length,
      total_pages: Math.ceil(rows.length / per_page),
    });
  }
  if (path === "/user/tokens/verify") return envelope({ id: "9".repeat(32), status: "active" });
  return undefined;
}
