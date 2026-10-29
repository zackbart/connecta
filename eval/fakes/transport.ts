/**
 * The one process-wide fake vendor transport. Every eval fake that answers for
 * a fixed vendor origin registers here instead of patching `globalThis.fetch`
 * or the guarded kit transport itself.
 *
 * - One fetch patch and one guarded-transport hold, refcounted. The patch is
 *   installed by the first registration or hold and removed only when the last
 *   one is released, so worlds may start and stop in any interleaved order.
 * - Routing is by credential and issuer, never by host alone: a route owns the
 *   bearer tokens, API keys, OAuth client ids and JWT issuers its world minted,
 *   so concurrent worlds of one family stay isolated from each other.
 * - Fail closed: while installed, a non-loopback request that no live route
 *   owns throws. Eval worlds are hermetic, so this covers every host, not just
 *   the known vendor ones; agent runners are child processes with their own
 *   network and are unaffected. Loopback requests pass through unchanged.
 */
import { configureGuardedTransport, type GuardedTransport } from "../../src/guarded-transport.js";

export interface FakeRoute {
  /** Vendor hostnames this route answers for; https on the default port only. */
  readonly hosts: readonly string[];
  /** Whether this world minted the credential: a token, key, client id, or `iss:<issuer>`. */
  owns(credential: string): boolean;
  /** A loopback origin to rewrite onto, or an in-process handler. */
  readonly target: string | ((request: Request) => Response | Promise<Response>);
  /** Tell a loopback fake which vendor origin the provider addressed. */
  readonly stampVendorOrigin?: boolean;
}

class EvalTransportRefusal extends Error {
  override name = "EvalTransportRefusal";
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Maintained provider hosts, so a refusal names an unowned vendor credential rather than an unknown host. */
const VENDOR_HOSTS = new Set([
  "api.stripe.com",
  "files.stripe.com",
  "meter-events.stripe.com",
  "api.cloudflare.com",
  "api.vercel.com",
  "api.github.com",
  "api.ccbchurch.com",
  "api.planningcenteronline.com",
  "public-api.granola.ai",
  "sandbox-quickbooks.api.intuit.com",
  "quickbooks.api.intuit.com",
  "oauth.platform.intuit.com",
  "developer.api.intuit.com",
  "gmail.googleapis.com",
  "www.googleapis.com",
  "docs.googleapis.com",
  "sheets.googleapis.com",
  "slides.googleapis.com",
  "forms.googleapis.com",
  "oauth2.googleapis.com",
]);

const routes = new Set<FakeRoute>();
const routedSender: GuardedTransport = { send: (url, init) => globalThis.fetch(url, init) };
let references = 0;
let original: typeof fetch | undefined;
let patch: typeof fetch | undefined;
let holds = 0;
let previousTransport: GuardedTransport | undefined;

const vendorHost = (host: string) =>
  VENDOR_HOSTS.has(host) || host.endsWith(".breezechms.com") || [...routes].some((r) => r.hosts.includes(host));

function jwtIssuer(value: string): string | undefined {
  const parts = value.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const iss = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()).iss;
    return iss === undefined ? undefined : `iss:${iss}`;
  } catch {
    return undefined;
  }
}

/** Every credential-like value a request carries, in no trusted order; routes decide ownership. */
async function credentials(request: Request): Promise<string[]> {
  const found: (string | undefined)[] = [];
  const authorization = request.headers.get("authorization") ?? "";
  if (/^bearer /i.test(authorization)) {
    const bearer = authorization.slice(7).trim();
    found.push(bearer, jwtIssuer(bearer));
  } else if (/^basic /i.test(authorization)) {
    const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString();
    found.push(decoded.split(":")[0]);
  } else if (authorization) found.push(authorization);
  for (const header of ["api-key", "x-api-key", "x-auth-key"]) found.push(request.headers.get(header) ?? undefined);
  if (request.method === "POST" && request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(await request.clone().text());
    const assertion = form.get("assertion");
    found.push(form.get("client_id") ?? undefined, form.get("refresh_token") ?? undefined);
    if (assertion) found.push(jwtIssuer(assertion));
  }
  return [...new Set(found.filter((value): value is string => !!value))];
}

async function route(forward: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (LOOPBACK.has(url.hostname)) return forward(input, init);
  if (!vendorHost(url.hostname))
    throw new EvalTransportRefusal(
      `Eval refused non-loopback transport to ${url.hostname}: fake worlds are hermetic and no fake owns this host.`,
    );
  const request = new Request(input, init);
  if (url.protocol !== "https:" || url.port)
    throw new EvalTransportRefusal(`Eval refused non-fake vendor transport: unexpected origin ${url.origin}.`);
  const presented = await credentials(request);
  const owners = [...routes].filter(
    (candidate) => candidate.hosts.includes(url.hostname) && presented.some((value) => candidate.owns(value)),
  );
  if (owners.length !== 1)
    throw new EvalTransportRefusal(
      owners.length
        ? `Eval refused non-fake vendor transport to ${url.hostname}: ${owners.length} live fakes claim one credential.`
        : `Eval refused non-fake vendor transport to ${url.hostname}: no live fake owns the presented credential.`,
    );
  const owner = owners[0]!;
  if (typeof owner.target === "function") return owner.target(request);
  const rewritten = new Request(`${owner.target}${url.pathname}${url.search}`, request);
  if (owner.stampVendorOrigin) rewritten.headers.set("x-eval-vendor-origin", url.origin);
  return forward(rewritten);
}

function acquire(): () => void {
  if (references++ === 0) {
    const forward = globalThis.fetch;
    original = forward;
    patch = ((input, init) => route(forward, input, init)) as typeof fetch;
    globalThis.fetch = patch;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--references > 0) return;
    // A wrapper stacked above the patch keeps it; with no routes it still refuses non-loopback.
    if (globalThis.fetch === patch) globalThis.fetch = original!;
    original = patch = undefined;
  };
}

/** Route one world's credentials for its vendor hosts until the returned release runs. */
export function routeFakeVendor(fake: FakeRoute): () => void {
  const release = acquire();
  routes.add(fake);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    routes.delete(fake);
    release();
  };
}

/**
 * Pin the guarded kit transport to the routed fetch. Each `listen()` installs
 * Node's owned sender, which bypasses `globalThis.fetch`, so call this
 * synchronously after every `listen()` that serves fake vendor connectors.
 */
export function holdFakeKitTransport(): () => void {
  const release = acquire();
  const previous = configureGuardedTransport(routedSender);
  if (holds++ === 0) previousTransport = previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) {
      configureGuardedTransport(previousTransport);
      previousTransport = undefined;
    }
    release();
  };
}

/** After a `listen()` that serves no fake vendor, restore the pin other live worlds hold. */
export function repinFakeKitTransport(): void {
  if (holds > 0) configureGuardedTransport(routedSender);
}

/** Live counts, for selftests proving release order does not matter. */
export function fakeTransportState() {
  return { routes: routes.size, references, holds, installed: patch !== undefined };
}
