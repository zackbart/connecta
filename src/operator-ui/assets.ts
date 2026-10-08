import { OPERATOR_UI_ASSETS } from "./generated.js";

/** Web APIs only: identical bytes and cache semantics on Node and Workers. */
export function operatorAsset(request: Request, path: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } });
  }
  const asset = Object.hasOwn(OPERATOR_UI_ASSETS, path) ? OPERATOR_UI_ASSETS[path] : undefined;
  if (!asset)
    return new Response(request.method === "HEAD" ? null : "Not Found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  const headers = {
    "Content-Type": asset.type,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    ETag: `"${path.slice(path.lastIndexOf("/") + 1)}"`,
  };
  if (
    request.headers
      .get("If-None-Match")
      ?.split(",")
      .some((tag) => tag.trim().replace(/^W\//, "") === headers.ETag || tag.trim() === "*")
  ) {
    return new Response(null, { status: 304, headers });
  }
  const body =
    request.method === "HEAD"
      ? null
      : asset.binary
        ? Uint8Array.from(atob(asset.body), (char) => char.charCodeAt(0))
        : asset.body;
  return new Response(body, { headers });
}
