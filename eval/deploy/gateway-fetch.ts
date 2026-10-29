/**
 * The Worker side of the vendor gateway (eval/deploy/worker.ts), Node-free so
 * workerd bundles it and the selftest drives it with a stand-in network.
 *
 * Loopback fakes are fetched directly; every other hop goes to the gateway
 * with the trial's gateway token. Redirects follow the fake transport's rules
 * (eval/fakes/transport.ts): every physical hop is `redirect: "manual"`, each
 * followed hop is classified again, a cross-origin hop drops Authorization,
 * Cookie and Proxy-Authorization, `redirect: "error"` rejects, and more than
 * 20 hops reject.
 */
export const GATEWAY_TOKEN_HEADER = "x-eval-gateway-token";
export const GATEWAY_ERROR_HEADER = "x-eval-gateway-error";
export const VENDOR_URL_HEADER = "x-eval-vendor-url";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_SENSITIVE = ["authorization", "cookie", "proxy-authorization"];
const BODY_HEADERS = ["content-type", "content-length", "content-encoding"];

export function viaGateway(native: typeof fetch, gateway: string, token: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const original = new Request(input, init);
    const mode = original.redirect;
    let url = new URL(original.url);
    let method = original.method;
    let headers = new Headers(original.headers);
    let body: ArrayBuffer | null =
      original.method === "GET" || original.method === "HEAD" ? null : await original.arrayBuffer();
    for (let hops = 0; ; hops++) {
      let response: Response;
      if (LOOPBACK.has(url.hostname)) {
        response = await native(url, { method, headers, body, redirect: "manual", signal: original.signal });
      } else {
        const forwarded = new Headers(headers);
        forwarded.set(VENDOR_URL_HEADER, url.href);
        forwarded.set(GATEWAY_TOKEN_HEADER, token);
        response = await native(gateway, {
          method,
          headers: forwarded,
          body,
          redirect: "manual",
          signal: original.signal,
        });
        // The routed transport rejected the request, as fetch would on Node.
        if (response.headers.get(GATEWAY_ERROR_HEADER)) throw new TypeError(await response.text());
      }
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || mode === "manual" || location === null) return response;
      await response.body?.cancel();
      if (mode === "error") throw new TypeError("fetch failed: redirect mode is error");
      if (hops >= 20) throw new TypeError("fetch failed: redirect count exceeded");
      const next = new URL(location, url);
      headers = new Headers(headers);
      if (next.origin !== url.origin) for (const name of CROSS_ORIGIN_SENSITIVE) headers.delete(name);
      if (
        (response.status === 303 && method !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = null;
        for (const name of BODY_HEADERS) headers.delete(name);
      }
      url = next;
    }
  }) as typeof fetch;
}
