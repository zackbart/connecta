/**
 * Negative controls for the worker target (#1173 item 0.2): the vendor
 * gateway's credential and loopback refusal, the Worker-side redirect rules,
 * process-group cleanup after a launcher crash, the egress guard on wrangler's
 * own Node processes, and comparator provenance across targets.
 */
import { startVendorGateway } from "../deploy/worker.js";
import { GATEWAY_ERROR_HEADER, GATEWAY_TOKEN_HEADER, VENDOR_URL_HEADER, viaGateway } from "../deploy/gateway-fetch.js";
import { routeFakeVendor } from "../fakes/transport.js";
import { serveFetch } from "../support/serve.js";

async function rejects(action: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (pattern.test(String(error instanceof Error ? error.message : error))) return;
    throw new Error(`${message}: ${String(error)}`);
  }
  throw new Error(message);
}

/** Only the trial's Worker may use the gateway, and never to reach a local service. */
export async function gatewayControls() {
  const seen: Headers[] = [];
  const local = await serveFetch(async (request) => {
    seen.push(request.headers);
    return new Response("local service");
  });
  const release = routeFakeVendor({
    hosts: ["api.stripe.com"],
    owns: (credential) => credential === "sk_test_gateway_control",
    target: local.url,
  });
  const gateway = await startVendorGateway();
  try {
    const send = (headers: Record<string, string>) => fetch(gateway.url, { headers, redirect: "manual" });
    for (const [label, headers] of [
      ["no credential", { [VENDOR_URL_HEADER]: `${local.url}/` }],
      ["a wrong credential", { [VENDOR_URL_HEADER]: `${local.url}/`, [GATEWAY_TOKEN_HEADER]: "guess" }],
    ] as const) {
      const response = await send(headers);
      if (response.status !== 403 || !response.headers.get(GATEWAY_ERROR_HEADER))
        throw new Error(`Gateway admitted a request with ${label}: HTTP ${response.status}`);
    }
    for (const target of [
      `${local.url}/`,
      local.url.replace("127.0.0.1", "localhost"),
      local.url.replace("127.0.0.1", "127.0.0.2"),
      local.url.replace("127.0.0.1", "[::1]"),
      local.url.replace("127.0.0.1", "[::ffff:127.0.0.1]"),
      "file:///etc/passwd",
    ]) {
      const response = await send({ [VENDOR_URL_HEADER]: target, [GATEWAY_TOKEN_HEADER]: gateway.token });
      if (response.status !== 403) throw new Error(`Gateway forwarded to ${target}: HTTP ${response.status}`);
    }
    const unknown = await send({ [VENDOR_URL_HEADER]: "https://example.com/", [GATEWAY_TOKEN_HEADER]: gateway.token });
    if (unknown.status !== 502 || !/Eval refused/.test(await unknown.text()))
      throw new Error("Gateway reached a host the fake transport does not own");
    if (seen.length) throw new Error("A refused gateway request reached the local service");
    const routed = await send({
      [VENDOR_URL_HEADER]: "https://api.stripe.com/v1/balance",
      [GATEWAY_TOKEN_HEADER]: gateway.token,
      Authorization: "Bearer sk_test_gateway_control",
    });
    if (routed.status !== 200 || seen.length !== 1) throw new Error("Gateway did not route an owned vendor credential");
    if (seen[0]!.has(GATEWAY_TOKEN_HEADER) || seen[0]!.has(VENDOR_URL_HEADER))
      throw new Error("Gateway forwarded its own credential or routing header");
  } finally {
    await gateway.close();
    release();
    await local.close();
  }
}

/** The Worker's wrapper follows redirects under the fake transport's rules. */
export async function gatewayRedirectControls() {
  const GATEWAY = "http://127.0.0.1:1/gateway";
  const calls: { url: string; method: string; headers: Headers; hasBody: boolean }[] = [];
  let script: (url: URL, hop: number) => Response = () => new Response("ok");
  const native = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const url = String(input) === GATEWAY ? new URL(headers.get(VENDOR_URL_HEADER)!) : new URL(String(input));
    calls.push({ url: String(input), method: init?.method ?? "GET", headers, hasBody: init?.body != null });
    if (init?.redirect !== "manual") throw new Error("Wrapper dispatched a hop without redirect: manual");
    return script(url, calls.length);
  }) as typeof fetch;
  const wrapped = viaGateway(native, GATEWAY, "trial-token");
  const sensitive = { Authorization: "Bearer sk_secret", Cookie: "session=1", "Proxy-Authorization": "Basic x" };
  const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });
  const run = async (
    steps: ((url: URL) => Response)[],
    init: RequestInit = {},
    input = "https://api.stripe.com/v1/a",
  ) => {
    calls.length = 0;
    script = (url, hop) => steps[Math.min(hop, steps.length) - 1]!(url);
    return wrapped(input, { headers: sensitive, ...init });
  };

  // Cross-origin hop onto another loopback service: no credential follows.
  await run([() => redirect(302, "http://127.0.0.1:9/other"), () => new Response("ok")]);
  const crossed = calls[1]!;
  if (crossed.url !== "http://127.0.0.1:9/other") throw new Error("Wrapper sent a loopback hop to the gateway");
  for (const name of ["authorization", "cookie", "proxy-authorization", GATEWAY_TOKEN_HEADER])
    if (crossed.headers.has(name)) throw new Error(`Cross-origin redirect kept ${name}`);
  if (calls[0]!.headers.get(GATEWAY_TOKEN_HEADER) !== "trial-token")
    throw new Error("Gateway hop did not carry the trial credential");

  // A stripped header stays stripped on a later hop back to the first origin.
  await run([
    () => redirect(307, "https://files.stripe.com/f"),
    () => redirect(307, "https://api.stripe.com/v1/b"),
    () => new Response("ok"),
  ]);
  if (calls[2]!.headers.has("authorization")) throw new Error("A stripped credential returned on a later hop");

  // Same-origin hop keeps the credential.
  await run([() => redirect(301, "/v1/c"), () => new Response("ok")]);
  if (calls[1]!.headers.get("authorization") !== "Bearer sk_secret")
    throw new Error("Same-origin redirect dropped the credential");

  // 303 after POST becomes a bodiless GET without body headers.
  await run([() => redirect(303, "/v1/d"), () => new Response("ok")], {
    method: "POST",
    body: "x=1",
    headers: { ...sensitive, "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (calls[1]!.method !== "GET" || calls[1]!.hasBody || calls[1]!.headers.has("content-type"))
    throw new Error("303 after POST did not become a bodiless GET");

  await rejects(
    () => run([() => redirect(302, "/v1/e")], { redirect: "error" }),
    /redirect mode is error/,
    "redirect: error returned the redirect",
  );
  const manual = await run([() => redirect(302, "/v1/f")], { redirect: "manual" });
  if (manual.status !== 302 || calls.length !== 1) throw new Error("redirect: manual followed the redirect");
  await rejects(
    () => run([() => redirect(302, "/v1/loop")]),
    /redirect count exceeded/,
    "Wrapper followed more than 20 redirects",
  );
  await rejects(
    () =>
      run([
        () =>
          new Response("Eval refused non-loopback transport", {
            status: 502,
            headers: { [GATEWAY_ERROR_HEADER]: "1" },
          }),
      ]),
    /Eval refused/,
    "A gateway refusal did not reject the fetch",
  );
}
