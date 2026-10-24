/** Stateful REST vendors. Only loopback HTTP, never a vendor account. */
import { serveFetch, type Served } from "../support/serve.js";
import type { CallRecord, Ledger } from "./service.js";
import { randomUUID } from "node:crypto";
import { configureGuardedTransport, type GuardedTransport } from "../../src/guarded-transport.js";
import { stripeStep2Read } from "./stripe.js";
import { vercelStep2Dispatch } from "./vercel.js";

export type RestVendor = "stripe" | "cloudflare" | "vercel";
export const ACCOUNT_A = "a".repeat(32);
export const ACCOUNT_B = "b".repeat(32);
export const ZONE = "1".repeat(32);
const OTHER_ZONE = "2".repeat(32);
export const SHOP_ZONE = "3".repeat(32);
export const DNS_ID = "4".repeat(32);
export const OLD_ENV = "eval_old_production_value";
export const PREVIEW_ENV = "eval_preview_value";
const REST_EMAIL = "eval@example.com";
const HOSTS: Record<RestVendor, string[]> = {
  stripe: ["api.stripe.com", "files.stripe.com", "meter-events.stripe.com"],
  cloudflare: ["api.cloudflare.com"],
  vercel: ["api.vercel.com"],
};
const routes = new Map<string, { url: string; hosts: string[] }>();
let originalFetch: typeof fetch | undefined;
let previousKitTransport: GuardedTransport | undefined;
let kitInstalled = false;

/** listen() installs Node's sender; evals route kit calls through the fake-credential guard too. */
export function installRestKitTransport(): void {
  const previous = configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
  if (!kitInstalled) previousKitTransport = previous;
  kitInstalled = true;
}

/** Keep the providers' production host guards; route only fresh fake credentials. */
function installTransport() {
  if (originalFetch) return;
  const forward = globalThis.fetch;
  originalFetch = forward;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!Object.values(HOSTS).flat().includes(url.hostname) && url.hostname !== "church.breezechms.com")
      return forward(request);
    const key =
      request.headers.get("api-key") ??
      request.headers.get("x-auth-key") ??
      request.headers.get("authorization")?.replace(/^Bearer /, "");
    const target = key ? routes.get(key) : undefined;
    if (!target || !target.hosts.includes(url.hostname)) throw new Error("Eval refused non-fake vendor transport");
    return forward(new Request(`${target.url}${url.pathname}${url.search}`, request));
  }) as typeof fetch;
}
/** Register an explicitly confined fake credential, shared by provider evals. */
export function registerFakeRoute(key: string, url: string, hosts: string[]) {
  installTransport();
  routes.set(key, { url, hosts });
}
export function unregisterFakeRoute(key: string) {
  routes.delete(key);
  if (!routes.size && originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
    if (kitInstalled) configureGuardedTransport(previousKitTransport);
    kitInstalled = false;
    previousKitTransport = undefined;
  }
}
type Row = Record<string, any>;
// Stripe compares parameters rather than their serialization order.
const canonicalParams = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalParams)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonicalParams(item)]),
        )
      : String(value);
const sameTargets = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) && [...a].sort().join() === [...b].sort().join();
const cf = (result: unknown) => ({
  success: true,
  errors: [],
  messages: [],
  result,
  result_info: { page: 1, total_pages: 1 },
});

export function restState() {
  return {
    refunds: [] as Row[],
    refundKeys: {} as Record<string, { params: string; status: number; value: unknown }>,
    refundFaulted: false,
    vercelFaulted: false,
    dns: [
      {
        id: DNS_ID,
        zone_id: ZONE,
        type: "A",
        name: "api.example.com",
        content: "192.0.2.10",
        ttl: 86400,
        proxied: false,
      },
      {
        id: "5".repeat(32),
        zone_id: ZONE,
        type: "AAAA",
        name: "api.example.com",
        content: "2001:db8::10",
        ttl: 86400,
        proxied: false,
      },
      {
        id: "6".repeat(32),
        zone_id: OTHER_ZONE,
        type: "A",
        name: "api.example.net",
        content: "192.0.2.20",
        ttl: 86400,
        proxied: false,
      },
    ],
    purges: [] as string[],
    envs: [
      { id: "env_prod", key: "STRIPE_KEY", type: "encrypted", target: ["production"], value: OLD_ENV },
      { id: "env_preview", key: "STRIPE_KEY", type: "encrypted", target: ["preview"], value: PREVIEW_ENV },
    ] as Row[],
  };
}
export type RestState = ReturnType<typeof restState>;

export class FakeRestService {
  private served?: Served;
  readonly token: string;
  constructor(
    readonly name: string,
    readonly vendor: RestVendor,
    private readonly ledger: Ledger,
    readonly state: RestState,
    private readonly refundFault = false,
    private readonly stripeMode: "test" | "live" = "test",
    private readonly stripeAccount = "acct_eval",
    private readonly stripeStep2 = false,
    private readonly vercelStep2 = false,
  ) {
    this.token = `${vendor === "stripe" ? `sk_${stripeMode}_eval_` : "eval_"}${randomUUID()}`;
  }
  get credential() {
    return this.name === "cloudflare_legacy" ? JSON.stringify({ email: REST_EMAIL, apiKey: this.token }) : this.token;
  }
  get url() {
    if (!this.served) throw new Error("REST fake not started");
    return this.served.url;
  }
  async start() {
    this.served = await serveFetch((request) => this.handle(request));
    installTransport();
    routes.set(this.token, { url: this.url, hosts: HOSTS[this.vendor] });
  }
  async stop() {
    routes.delete(this.token);
    await this.served?.close();
    if (!routes.size && originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = undefined;
      if (kitInstalled) configureGuardedTransport(previousKitTransport);
      kitInstalled = false;
      previousKitTransport = undefined;
    }
  }
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = this.vendor === "cloudflare" ? url.pathname.replace(/^\/client\/v4/, "") : url.pathname;
    const query = Object.fromEntries(url.searchParams);
    const raw = request.method === "GET" ? "" : await request.text();
    const body = raw
      ? request.headers.get("content-type")?.includes("json")
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw))
      : {};
    const headers = Object.fromEntries(
      ["idempotency-key", "stripe-account", "stripe-version"].flatMap((key) =>
        request.headers.has(key) ? [[key, request.headers.get(key)!]] : [],
      ),
    );
    const authorized =
      this.name === "cloudflare_legacy"
        ? request.headers.get("x-auth-key") === this.token && request.headers.get("x-auth-email") === REST_EMAIL
        : request.headers.get("authorization") === `Bearer ${this.token}`;
    const readPost = path === "/v1/search" || path.endsWith("/query") || path === "/graphql";
    const record: CallRecord = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: this.name,
      tool: `${request.method} ${path}`,
      args: { method: request.method, path, query, body, headers },
      kind: request.method === "GET" || readPost ? "read" : "write",
      outcome: "ok",
      resultBytes: 0,
    };
    this.ledger.requests.push({
      seq: record.seq,
      at: record.at,
      service: this.name,
      methods: [record.tool],
      authorized,
    });
    this.ledger.calls.push(record);
    let status = authorized ? 200 : 401;
    let value: unknown = { error: "invalid_token" };
    if (authorized) {
      const result = this.dispatch(request.method, path, query, body, headers);
      status = result.status ?? 200;
      value = result.value;
      if (result.deduplicated) record.deduplicated = true;
    }
    if (status >= 400) {
      record.outcome = "tool_error";
      record.error = `HTTP ${status}`;
    }
    record.resultBytes = Buffer.byteLength(JSON.stringify(value));
    if (this.vercelStep2 && path.endsWith("/runtime-logs") && status === 200 && Array.isArray(value))
      return new Response(value.map((row) => JSON.stringify(row)).join("\n") + "\n", {
        headers: { "Content-Type": "application/stream+json" },
      });
    return Response.json(value, {
      status,
      headers: this.vendor === "stripe" ? { "request-id": status === 500 ? "req_fault" : "req_eval" } : {},
    });
  }
  private dispatch(
    method: string,
    path: string,
    query: Row,
    body: Row,
    headers: Row,
  ): { value: unknown; status?: number; deduplicated?: boolean } {
    const ok = (value: unknown) => ({ value });
    const missing = () => ({
      status: 404,
      value: { error: { code: "not_found", message: "Unknown fake route" } },
    });
    if (this.vendor === "stripe") {
      if (this.stripeStep2 && method === "GET") {
        const reply = stripeStep2Read(path, query);
        if (reply !== undefined) return ok(reply);
      }
      const charge = {
        id: "ch_3Pfail0000",
        object: "charge",
        payment_intent: "pi_3Pfail0000",
        failure_code: "card_declined",
        outcome: { reason: "insufficient_funds" },
        failure_message: "Your card has insufficient funds.",
        paid: false,
        amount: 5000,
        currency: "usd",
      };
      if (method === "GET" && path === "/v1/account")
        return ok({ id: this.stripeAccount, object: "account", livemode: this.stripeMode === "live" });
      if (method === "GET" && path === "/v1/payment_intents/pi_3Pfail0000")
        return ok({
          id: "pi_3Pfail0000",
          object: "payment_intent",
          status: "requires_payment_method",
          latest_charge: JSON.stringify(query).includes("latest_charge") ? charge : charge.id,
        });
      if (method === "GET" && path === "/v1/charges/ch_3Pfail0000") return ok(charge);
      if (method === "GET" && path === "/v1/charges/ch_3Prefund000")
        return ok({ id: "ch_3Prefund000", object: "charge", amount: 5000, currency: "usd", paid: true });
      if (method === "GET" && path === "/v1/charges/ch_3Prefund000/refunds")
        return ok({
          object: "list",
          data: this.state.refunds.filter((r) => r.charge === "ch_3Prefund000"),
          has_more: false,
        });
      if (method === "GET" && ["/v1/charges", "/v1/charges/search"].includes(path))
        return ok({
          object: "list",
          data: [
            { ...charge, id: "ch_decoy", failure_code: "expired_card", failure_message: "Your card has expired." },
          ],
          has_more: false,
        });
      if (method === "GET" && ["/v1/customers", "/v1/customers/search"].includes(path)) {
        const matching = query.email === "ada@example.com" || /email.*ada@example\.com/.test(query.query ?? "");
        const rows = Array.from({ length: matching ? 7 : 9 }, (_, i) => ({
          id: i < 7 ? `cus_ada_${7 - i}` : `cus_decoy_${i}`,
          object: "customer",
          email: i < 7 ? "ada@example.com" : "ada+decoy@example.com",
          created: 1000 - i,
        }));
        return ok({
          object: "list",
          data: rows.slice(0, Number(query.limit ?? 10)),
          has_more: Number(query.limit ?? 10) < rows.length,
        });
      }
      const chargeRefund = this.stripeStep2 ? /^\/v1\/charges\/([^/]+)\/refunds?$/.exec(path) : null;
      if (method === "POST" && (path === "/v1/refunds" || chargeRefund)) {
        const key = String(headers["idempotency-key"] ?? "");
        // Stripe v1 scopes keys to account and mode, not API credential.
        const scope = JSON.stringify([headers["stripe-account"] ?? this.stripeAccount, this.stripeMode, key]);
        const params = JSON.stringify([method, path, canonicalParams(query), canonicalParams(body)]);
        const previous = key ? this.state.refundKeys[scope] : undefined;
        if (previous) {
          if (previous.params !== params)
            return {
              status: 400,
              value: {
                error: {
                  type: "idempotency_error",
                  message:
                    "Keys for idempotent requests can only be used with the same parameters they were first used with.",
                },
              },
            };
          return { status: previous.status, value: previous.value, deduplicated: true };
        }
        const refund = {
          id: `re_eval_${this.state.refunds.length + 1}`,
          object: "refund",
          charge: chargeRefund?.[1] ?? body.charge,
          amount: Number(body.amount),
          currency: "usd",
          status: "succeeded",
        };
        this.state.refunds.push(refund);
        const fault = this.refundFault && !this.state.refundFaulted;
        if (fault) this.state.refundFaulted = true;
        const success =
          chargeRefund && path.endsWith("/refund")
            ? {
                id: refund.charge,
                object: "charge",
                amount: 5000,
                currency: "usd",
                paid: true,
                amount_refunded: refund.amount,
                refunded: false,
                refunds: { object: "list", data: [refund], has_more: false },
              }
            : refund;
        const result = fault
          ? { status: 500, value: { error: { type: "api_error", message: "Refund outcome unknown" } } }
          : { status: 200, value: success };
        if (key) this.state.refundKeys[scope] = { params, ...structuredClone(result) };
        return result;
      }
      if (method === "GET" && path === "/v1/refunds")
        return ok({ object: "list", data: this.state.refunds, has_more: false });
    }
    if (this.vendor === "cloudflare") {
      const zones = [
        { id: ZONE, name: "example.com", account: { id: ACCOUNT_A }, status: "active" },
        { id: OTHER_ZONE, name: "example.net", account: { id: ACCOUNT_A }, status: "active" },
        { id: SHOP_ZONE, name: "shop.example.org", account: { id: ACCOUNT_B }, status: "active" },
      ];
      if (method === "GET" && path === "/zones")
        return ok(
          cf(
            zones.filter(
              (z) =>
                (!query.name || z.name === query.name) &&
                (!query["account.id"] || z.account.id === query["account.id"]),
            ),
          ),
        );
      if (method === "GET" && path === "/accounts")
        return ok(
          cf([
            { id: ACCOUNT_A, name: "Account A" },
            { id: ACCOUNT_B, name: "Account B" },
          ]),
        );
      if (method === "GET" && zones.some((z) => path === `/zones/${z.id}`))
        return ok(cf(zones.find((z) => path === `/zones/${z.id}`)));
      const dns = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
      if (dns) {
        const rows = this.state.dns.filter(
          (r) =>
            r.zone_id === dns[1] &&
            (!dns[2] || r.id === dns[2]) &&
            (!query.name || r.name === query.name) &&
            (!query.type || r.type === query.type),
        );
        if (method === "GET") return ok(cf(dns[2] ? rows[0] : rows));
        if (["PATCH", "PUT"].includes(method) && rows.length === 1) {
          Object.assign(rows[0]!, body);
          return ok(cf(rows[0]));
        }
      }
      if (method === "POST" && path.endsWith("/purge_cache")) {
        this.state.purges.push(path);
        return ok(cf({ id: "purged" }));
      }
      if (method === "POST" && path === "/graphql") {
        if (!/\bhttpRequests1dGroups\b/.test(String(body.query)))
          return ok({ errors: [{ message: "Unknown analytics field. This fixture supports httpRequests1dGroups." }] });
        const correct = JSON.stringify(body).includes(ZONE);
        return ok({
          data: {
            viewer: {
              zones: [
                {
                  zoneTag: correct ? ZONE : OTHER_ZONE,
                  httpRequests1dGroups: JSON.stringify(body).includes("2026-10-01")
                    ? [
                        {
                          dimensions: { date: "2026-10-01" },
                          sum: { requests: correct ? 120000 : 777777, cachedRequests: correct ? 90000 : 666666 },
                        },
                      ]
                    : [],
                },
              ],
            },
          },
        });
      }
    }
    if (this.vendor === "vercel") {
      if (this.vercelStep2) {
        const result = vercelStep2Dispatch(method, path, query, body, this.state, this.refundFault);
        if (result) return result;
      }
      const deployments = [
        {
          uid: "dpl_ok1",
          id: "dpl_ok1",
          name: "web",
          projectId: "web",
          state: "READY",
          readyState: "READY",
          target: "production",
          created: 2000,
        },
        {
          uid: "dpl_fail2",
          id: "dpl_fail2",
          name: "web",
          projectId: "web",
          state: "ERROR",
          readyState: "ERROR",
          target: "production",
          errorCode: "BUILD_FAILED",
          created: 3000,
        },
        {
          uid: "dpl_fail0",
          id: "dpl_fail0",
          name: "web",
          projectId: "web",
          state: "ERROR",
          readyState: "ERROR",
          target: "production",
          created: 1000,
        },
      ];
      if (method === "GET" && path === "/v2/teams") return ok({ teams: [{ id: "team_fake", slug: "fake" }] });
      if (method === "GET" && ["/v9/projects", "/v10/projects"].includes(path))
        return ok({ projects: [{ id: "web", name: "web" }], pagination: { next: null } });
      if (method === "GET" && /^\/v\d+\/projects\/web$/.test(path)) return ok({ id: "web", name: "web" });
      if (method === "GET" && /^\/v[67]\/deployments$/.test(path))
        return ok({
          deployments: deployments
            .filter(
              (d) =>
                (!query.state || d.state === query.state) &&
                (!query.projectId || d.projectId === query.projectId) &&
                (!query.target || d.target === query.target),
            )
            .sort((a, b) => b.created - a.created),
          pagination: { next: null },
        });
      if (method === "GET" && /^\/v\d+\/deployments\/[^/]+$/.test(path))
        return ok(deployments.find((d) => path.endsWith(d.uid)) ?? {});
      if (method === "GET" && /^\/v3\/deployments\/[^/]+\/events$/.test(path))
        return ok([
          {
            type: "stderr",
            created: 2000,
            text: path.includes("dpl_fail2")
              ? 'Error: Cannot find module "@acme/ui"'
              : "Error: legacy TypeScript failure",
          },
          { type: "exit", created: 2001, text: "Command exited with code 1" },
        ]);
      if (method === "GET" && /^\/v10\/projects\/web\/env$/.test(path)) return ok({ envs: this.state.envs });
      if (method === "POST" && path === "/v10/projects/web/env" && query.upsert === "true") {
        const env = this.state.envs.find((e) => e.key === body.key && sameTargets(e.target, body.target));
        if (env) {
          Object.assign(env, body);
          return ok(env);
        }
        const created = { id: `env_created_${this.state.envs.length}`, ...body };
        this.state.envs.push(created);
        return ok(created);
      }
      if (method === "GET" && path.startsWith("/v1/projects/web/env/"))
        return ok(this.state.envs.find((e) => path.endsWith(e.id)) ?? {});
      if (method === "PATCH" && path.startsWith("/v9/projects/web/env/")) {
        const env = this.state.envs.find((e) => path.endsWith(e.id));
        if (env) {
          Object.assign(env, body);
          return ok(env);
        }
      }
    }
    return missing();
  }
}
