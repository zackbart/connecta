// The routes behind artifact pages: a JSON API the operator shell calls with
// its session, and one constant, data-free frame the page renders in.
//
// The operator UI authenticates with a header, not a cookie — a bearer from
// localStorage or a Clerk session token — so a bare navigation to a page
// carries no credential. The trusted shell therefore fetches the page from
// `_api` and hands it to the frame with `postMessage`; the frame itself is
// served to anyone and holds nothing. What makes it safe is its response
// header: `sandbox allow-scripts` without `allow-same-origin` gives the page
// an opaque origin — no cookies, no storage, no route of this deployment it
// could call — and the fetch directives leave it no network.

import type { ActivityActor } from "../activity.js";
import { resolveActorLabels, actorKey } from "../routes/actor-labels.js";
import {
  authorize,
  mayViewArtifacts,
  privateJson,
  validateAuthPermissions,
  type RouteContext,
} from "../routes/shared.js";
import { buildFrameDocument, frameCsp } from "./document.js";
import { scriptSafeJson } from "./json.js";
import { freshnessOf } from "./refresh.js";
import type { ArtifactOperations } from "./operations.js";
import type { ArtifactAllowlist } from "./types.js";
import { ARTIFACT_ID } from "./validate.js";

const LIBRARY_PAGE = 50;
const MAX_QUERY_CHARS = 200;
const MAX_PINS = 32;
const PIN = /^([A-Za-z_][A-Za-z0-9_]{0,63}):(\d{1,9})$/;

const notFound = () => privateJson({ error: "not found" }, { status: 404 });

/** The frame's bootstrap: wait for exactly one document from the parent, then become it. */
function frameBootstrap(expectedOrigin: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body>
<script>
(() => {
  const expected = ${scriptSafeJson(expectedOrigin)};
  if (window.parent === window) return;
  const receive = (event) => {
    if (event.source !== window.parent || event.origin !== expected) return;
    const message = event.data;
    if (!message || message.type !== "document" || typeof message.html !== "string") return;
    window.removeEventListener("message", receive);
    document.open();
    document.write(message.html);
    document.close();
  };
  window.addEventListener("message", receive);
  window.parent.postMessage({ type: "ready" }, expected);
})();
</script>
</body></html>`;
}

export function artifactRoutes(options: {
  operations: ArtifactOperations;
  allowlist: ArtifactAllowlist;
}): (context: RouteContext) => Promise<Response | null> {
  const ops = options.operations;
  const csp = frameCsp(options.allowlist);

  /** The viewer's identity, or the Response that refuses it. */
  const admit = async (context: RouteContext) => {
    const { request, baseUrl, opts, runtimeContext } = context;
    if (opts.auth.length === 0) {
      // An open deployment has nobody to show a team page to.
      return privateJson(
        { error: "artifact pages need inbound authentication" },
        { status: 403 },
      );
    }
    const authz = await authorize(request, baseUrl, opts.auth, runtimeContext, opts.identity, false);
    if (!authz.ok) return authz.response;
    try {
      validateAuthPermissions(authz, opts.registry);
    } catch {
      return privateJson({ error: "invalid identity permission" }, { status: 403 });
    }
    // Refused like an absent page, so a slug's existence is not an oracle.
    return mayViewArtifacts(authz) ? authz : notFound();
  };

  const labelsFor = async (context: RouteContext, actors: ActivityActor[]) => {
    const labels = await resolveActorLabels(actors, context.opts.auth);
    return (actor: ActivityActor) => ({
      label: labels.get(actorKey(actor)) ?? actor.id ?? actor.kind,
    });
  };

  const library = async (context: RouteContext): Promise<Response> => {
    const admitted = await admit(context);
    if (admitted instanceof Response) return admitted;
    const params = context.url.searchParams;
    const query = (params.get("q") ?? "").slice(0, MAX_QUERY_CHARS);
    const cursor = params.get("cursor") ?? undefined;
    const listed = await ops.list({
      limit: LIBRARY_PAGE,
      ...(query ? { query } : {}),
      ...(params.get("archived") === "1" ? { includeArchived: true } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (!listed.ok) return privateJson({ error: "invalid cursor" }, { status: 400 });
    const label = await labelsFor(context, listed.items.map(({ head }) => head.updatedBy));
    return privateJson({
      artifacts: listed.items.map(({ id, head }) => ({
        id,
        title: head.title,
        kind: head.kind,
        viewVersion: head.view.version,
        updatedAt: head.updatedAt,
        updatedBy: label(head.updatedBy),
        archived: head.archived,
        freshness: freshnessOf(head),
      })),
      ...(listed.nextCursor !== undefined ? { nextCursor: listed.nextCursor } : {}),
    });
  };

  const view = async (context: RouteContext, id: string): Promise<Response> => {
    const admitted = await admit(context);
    if (admitted instanceof Response) return admitted;
    const params = context.url.searchParams;
    const pinned = params.get("v");
    let pin: { view: number; documents: Record<string, number> } | undefined;
    if (pinned !== null) {
      const pins = params.getAll("d");
      if (!/^\d{1,9}$/.test(pinned) || pins.length > MAX_PINS) return notFound();
      const documents: Record<string, number> = {};
      for (const entry of pins) {
        const match = PIN.exec(entry);
        if (!match?.[1] || match[1] === "__proto__") return notFound();
        documents[match[1]] = Number(match[2]);
      }
      pin = { view: Number(pinned), documents };
    }
    const page = await ops.page(id, pin ?? {});
    if (!page.ok) return notFound();
    const origin = new URL(context.baseUrl).origin;
    const url = `${origin}/artifacts/${id}`;
    const documents = Object.entries(page.documents).map(([name, { record }]) => ({
      name,
      version: record.version,
      updatedAt: record.at,
    }));
    const pins = documents.map(({ name, version }) => `d=${name}:${version}`);
    const label = await labelsFor(context, [page.view.by]);
    return privateJson({
      id,
      title: page.head.title,
      kind: page.head.kind,
      archived: page.head.archived,
      snapshot: pin !== undefined,
      latestViewVersion: page.head.view.version,
      view: {
        version: page.view.version,
        at: page.view.at,
        by: label(page.view.by),
      },
      documents,
      freshness: freshnessOf(page.head),
      url,
      snapshotUrl: `${url}/v/${page.view.version}${pins.length ? `?${pins.join("&")}` : ""}`,
      document: buildFrameDocument({
        kind: page.head.kind,
        source: page.source,
        global: {
          id,
          title: page.head.title,
          view: { version: page.view.version },
          documents: Object.fromEntries(
            documents.map(({ name, version, updatedAt }) => [name, { version, updatedAt }]),
          ),
          snapshot: pin !== undefined,
        },
        data: Object.fromEntries(
          Object.entries(page.documents).map(([name, { value }]) => [name, scriptSafeJson(value)]),
        ),
      }),
    });
  };

  return async (context) => {
    const { path, request } = context;
    const read = request.method === "GET" || request.method === "HEAD";
    if (path === "/artifacts/_frame") {
      if (!read) return privateJson({ error: "method not allowed" }, { status: 405 });
      return new Response(request.method === "HEAD" ? null : frameBootstrap(new URL(context.baseUrl).origin), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": csp,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        },
      });
    }
    if (!path.startsWith("/artifacts/_api/")) return null;
    if (request.method !== "GET") return privateJson({ error: "method not allowed" }, { status: 405 });
    if (path === "/artifacts/_api/list") return library(context);
    const match = /^\/artifacts\/_api\/view\/([^/]+)$/.exec(path);
    if (match?.[1] && ARTIFACT_ID.test(match[1])) return view(context, match[1]);
    return notFound();
  };
}
