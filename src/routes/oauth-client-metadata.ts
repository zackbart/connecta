import { selfHostedClientDocument } from "../auth/downstream-client-metadata.js";
import type { RouteContext } from "./shared.js";

/** Public OAuth client metadata, without auth, storage, discovery, or request-host input. */
export function routeOAuthClientMetadata(context: RouteContext): Response | null {
  if (!context.path.startsWith("/oauth/client-metadata/")) return null;
  const id = context.path.slice("/oauth/client-metadata/".length);
  const connector = context.opts.registry.getConnector(id);
  // Construction refuses a self-hosted document on a connector with members
  // (#1377); this keeps one from ever being served as anything but unknown.
  const document =
    connector &&
    context.opts.registry.connectorMembers(id) === undefined &&
    selfHostedClientDocument(connector, context.opts.config.publicUrl, context.opts.config.serverInfo.name);
  if (!document) return new Response(null, { status: 404 });
  if (context.request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  return Response.json(document, { headers: { "Cache-Control": "public, max-age=300" } });
}
