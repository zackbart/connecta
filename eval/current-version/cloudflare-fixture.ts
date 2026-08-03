/**
 * A Cloudflare v4 API double, spoken at the HTTP level.
 *
 * The reference-connection lane has to answer one question honestly: does the
 * maintained `cloudflare()` connection serve a cold agent well? Stubbing the
 * provider's internals would answer a different, easier question. So nothing
 * here touches the provider. This is an ordinary HTTP server that returns
 * Cloudflare's envelope — `{ success, errors, messages, result, result_info }`
 * — and the real connection is pointed at it through the `baseUrl` option the
 * provider already documents as "API base override for a proxy or a test
 * double". The real constructor, the real hand-written schemas, the real
 * projections, and the real status/code error mapping all run unmodified.
 *
 * No live credential and no real account payload is involved. Every id, domain,
 * and address below is fixture data under reserved test ranges: `.test` names
 * (RFC 6761) and `192.0.2.0/24` / `2001:db8::/32` documentation addresses
 * (RFC 5737, RFC 3849).
 *
 * The raw records are deliberately fat. A projection that drops nothing proves
 * nothing, so every zone and record carries the metadata Cloudflare really
 * returns and the connection really discards.
 */
import { createServer, type Server } from "node:http";
import { once } from "node:events";

/** The account every fixture zone belongs to. */
export const FIXTURE_ACCOUNT_ID = "acct_eval_edge";
const FIXTURE_ACCOUNT_NAME = "Connecta Eval Edge";

/** The zone the dependent-read case must resolve by name. */
export const FIXTURE_PRIMARY_ZONE_ID = "zone_eval_a1b2";
export const FIXTURE_PRIMARY_ZONE_NAME = "connecta-eval.test";

/**
 * The record-type census of the primary zone, and therefore the exact answer
 * the reduced dependent read must produce. Held here so the fixture and the
 * benchmark's `correct()` cannot drift apart.
 */
export const FIXTURE_RECORD_TYPE_COUNTS: Record<string, number> = {
  A: 24,
  AAAA: 6,
  CNAME: 14,
  MX: 4,
  TXT: 10,
  NS: 2,
};

interface FixtureZone {
  id: string;
  name: string;
  status: string;
}

const ZONES: FixtureZone[] = [
  { id: FIXTURE_PRIMARY_ZONE_ID, name: FIXTURE_PRIMARY_ZONE_NAME, status: "active" },
  { id: "zone_eval_c3d4", name: "staging.connecta-eval.test", status: "active" },
  { id: "zone_eval_e5f6", name: "legacy-eval.test", status: "pending" },
];

type JsonRecord = Record<string, unknown>;

function rawZone(zone: FixtureZone): JsonRecord {
  return {
    id: zone.id,
    name: zone.name,
    status: zone.status,
    paused: false,
    type: "full",
    development_mode: 0,
    name_servers: ["ada.ns.cloudflare.test", "bob.ns.cloudflare.test"],
    original_name_servers: ["ns1.registrar.test", "ns2.registrar.test"],
    original_registrar: "Fixture Registrar, Inc.",
    original_dnshost: null,
    modified_on: "2026-07-14T09:12:44.000Z",
    created_on: "2025-02-03T17:41:02.000Z",
    activated_on: "2025-02-03T18:02:19.000Z",
    meta: {
      step: 4,
      custom_certificate_quota: 0,
      page_rule_quota: 3,
      phishing_detected: false,
    },
    owner: { id: "owner_eval", type: "organization", name: FIXTURE_ACCOUNT_NAME },
    account: { id: FIXTURE_ACCOUNT_ID, name: FIXTURE_ACCOUNT_NAME },
    tenant: { id: null, name: null },
    tenant_unit: { id: null },
    permissions: ["#dns_records:edit", "#dns_records:read", "#zone:read"],
    plan: {
      id: "plan_free",
      name: "Free Website",
      price: 0,
      currency: "USD",
      frequency: "",
      is_subscribed: true,
      can_subscribe: false,
      legacy_id: "free",
      legacy_discount: false,
      externally_managed: false,
    },
    cname_suffix: "cdn.cloudflare.test",
    vanity_name_servers: [],
    verification_key: "fixture-verification-key",
  };
}

interface FixtureRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
  comment?: string;
}

/**
 * Build the primary zone's records so the type census matches
 * `FIXTURE_RECORD_TYPE_COUNTS` exactly. Deterministic and order-stable: the
 * same run must produce the same bytes on every repetition, or the token
 * measurements are noise.
 */
function buildPrimaryRecords(): FixtureRecord[] {
  const records: FixtureRecord[] = [];
  let sequence = 0;
  const next = (): string =>
    `dns_eval_${String(++sequence).padStart(3, "0")}`;

  for (let index = 0; index < FIXTURE_RECORD_TYPE_COUNTS["A"]!; index += 1) {
    records.push({
      id: next(),
      name: `a${String(index + 1).padStart(2, "0")}.${FIXTURE_PRIMARY_ZONE_NAME}`,
      type: "A",
      content: `192.0.2.${index + 1}`,
      ttl: 300,
      proxied: index % 2 === 0,
    });
  }
  for (let index = 0; index < FIXTURE_RECORD_TYPE_COUNTS["AAAA"]!; index += 1) {
    records.push({
      id: next(),
      name: `v6-${index + 1}.${FIXTURE_PRIMARY_ZONE_NAME}`,
      type: "AAAA",
      content: `2001:db8::${index + 1}`,
      ttl: 300,
      proxied: false,
    });
  }
  for (let index = 0; index < FIXTURE_RECORD_TYPE_COUNTS["CNAME"]!; index += 1) {
    records.push({
      id: next(),
      name: `alias${String(index + 1).padStart(2, "0")}.${FIXTURE_PRIMARY_ZONE_NAME}`,
      type: "CNAME",
      content: FIXTURE_PRIMARY_ZONE_NAME,
      ttl: 1,
      proxied: true,
    });
  }
  for (let index = 0; index < FIXTURE_RECORD_TYPE_COUNTS["MX"]!; index += 1) {
    records.push({
      id: next(),
      name: FIXTURE_PRIMARY_ZONE_NAME,
      type: "MX",
      content: `mx${index + 1}.mail.test`,
      ttl: 3600,
      proxied: false,
      priority: (index + 1) * 10,
    });
  }
  for (let index = 0; index < FIXTURE_RECORD_TYPE_COUNTS["TXT"]!; index += 1) {
    records.push({
      id: next(),
      name: `_txt${index + 1}.${FIXTURE_PRIMARY_ZONE_NAME}`,
      type: "TXT",
      content: `"connecta-eval-token-${index + 1}"`,
      ttl: 3600,
      proxied: false,
      ...(index === 0 ? { comment: "Domain verification for the eval lane." } : {}),
    });
  }
  for (let index = 0; index < FIXTURE_RECORD_TYPE_COUNTS["NS"]!; index += 1) {
    records.push({
      id: next(),
      name: `delegated${index + 1}.${FIXTURE_PRIMARY_ZONE_NAME}`,
      type: "NS",
      content: `ns${index + 1}.delegate.test`,
      ttl: 86_400,
      proxied: false,
    });
  }
  return records;
}

const RECORDS: Record<string, FixtureRecord[]> = {
  [FIXTURE_PRIMARY_ZONE_ID]: buildPrimaryRecords(),
  zone_eval_c3d4: [
    {
      id: "dns_stage_001",
      name: "staging.connecta-eval.test",
      type: "A",
      content: "192.0.2.200",
      ttl: 300,
      proxied: true,
    },
    {
      id: "dns_stage_002",
      name: "api.staging.connecta-eval.test",
      type: "CNAME",
      content: "staging.connecta-eval.test",
      ttl: 1,
      proxied: true,
    },
  ],
  zone_eval_e5f6: [],
};

function rawRecord(zoneId: string, record: FixtureRecord): JsonRecord {
  const zoneName =
    ZONES.find((zone) => zone.id === zoneId)?.name ?? FIXTURE_PRIMARY_ZONE_NAME;
  return {
    id: record.id,
    zone_id: zoneId,
    zone_name: zoneName,
    name: record.name,
    type: record.type,
    content: record.content,
    ttl: record.ttl,
    proxied: record.proxied,
    proxiable: record.type === "A" || record.type === "AAAA" || record.type === "CNAME",
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    comment: record.comment ?? null,
    comment_modified_on: record.comment ? "2026-06-02T11:00:00.000Z" : null,
    tags: [],
    tags_modified_on: null,
    locked: false,
    settings: {},
    meta: { auto_added: false, managed_by_apps: false, managed_by_argo_tunnel: false },
    created_on: "2025-02-04T08:15:00.000Z",
    modified_on: "2026-06-02T11:00:00.000Z",
  };
}

/** Cloudflare's success envelope. */
function ok(result: unknown, resultInfo?: JsonRecord): JsonRecord {
  return {
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo ? { result_info: resultInfo } : {}),
  };
}

/** Cloudflare's failure envelope, including the nested `error_chain` form. */
function failure(
  code: number,
  message: string,
  chain?: { code: number; message: string }[],
): JsonRecord {
  return {
    success: false,
    errors: [
      {
        code,
        message,
        ...(chain ? { error_chain: chain } : {}),
      },
    ],
    messages: [],
    result: null,
  };
}

export interface CloudflareFixtureOptions {
  /** The token the fixture accepts. */
  validToken: string;
  /**
   * A token the fixture rejects with Cloudflare's real 401 shape, so the
   * unavailable-auth case exercises the provider's status/code mapping rather
   * than a synthetic error.
   */
  revokedToken: string;
}

export interface CloudflareFixture {
  /** Base URL to hand the connection's `baseUrl` option. */
  readonly baseUrl: string;
  /** Every request the fixture received, for post-run assertions. */
  readonly requests: { method: string; path: string; token: string | null }[];
  close(): Promise<void>;
}

/**
 * Start the double on an ephemeral loopback port and return its `/client/v4`
 * base. Bound to 127.0.0.1: this must never be reachable off the machine.
 */
export async function startCloudflareFixture(
  options: CloudflareFixtureOptions,
): Promise<CloudflareFixture> {
  const requests: { method: string; path: string; token: string | null }[] = [];

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    requests.push({ method: request.method ?? "GET", path: url.pathname, token });

    const send = (status: number, body: JsonRecord): void => {
      const text = JSON.stringify(body);
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    };

    const path = url.pathname.startsWith("/client/v4")
      ? url.pathname.slice("/client/v4".length)
      : null;
    if (path === null) {
      send(404, failure(7003, "Could not route to the requested path."));
      return;
    }

    // Authentication first, exactly as Cloudflare orders it: a revoked token
    // never learns whether the resource exists.
    if (token === options.revokedToken) {
      send(
        401,
        failure(10_000, "Authentication error", [
          { code: 10_000, message: "Invalid API Token" },
        ]),
      );
      return;
    }
    if (token !== options.validToken) {
      send(401, failure(10_000, "Authentication error"));
      return;
    }

    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      const method = request.method ?? "GET";

      if (method === "GET" && path === "/user/tokens/verify") {
        send(200, ok({ id: "token_eval", status: "active" }));
        return;
      }

      if (method === "GET" && path === "/accounts") {
        send(
          200,
          ok(
            [
              {
                id: FIXTURE_ACCOUNT_ID,
                name: FIXTURE_ACCOUNT_NAME,
                type: "standard",
                created_on: "2025-01-02T00:00:00.000Z",
                settings: { enforce_twofactor: false },
              },
            ],
            { page: 1, per_page: 20, count: 1, total_count: 1, total_pages: 1 },
          ),
        );
        return;
      }

      if (method === "GET" && path === "/zones") {
        const nameFilter = url.searchParams.get("name");
        const statusFilter = url.searchParams.get("status");
        const matched = ZONES.filter(
          (zone) =>
            (!nameFilter || zone.name === nameFilter) &&
            (!statusFilter || zone.status === statusFilter),
        );
        const perPage = Number(url.searchParams.get("per_page") ?? "20");
        send(
          200,
          ok(matched.map(rawZone), {
            page: Number(url.searchParams.get("page") ?? "1"),
            per_page: perPage,
            count: matched.length,
            total_count: matched.length,
            total_pages: 1,
          }),
        );
        return;
      }

      const zoneMatch = /^\/zones\/([^/]+)$/.exec(path);
      if (method === "GET" && zoneMatch) {
        const zone = ZONES.find((candidate) => candidate.id === zoneMatch[1]);
        if (!zone) {
          send(404, failure(1049, "zone could not be found"));
          return;
        }
        send(200, ok(rawZone(zone)));
        return;
      }

      const recordsMatch = /^\/zones\/([^/]+)\/dns_records$/.exec(path);
      if (recordsMatch) {
        const zoneId = recordsMatch[1]!;
        const zone = ZONES.find((candidate) => candidate.id === zoneId);
        if (!zone) {
          send(404, failure(1049, "zone could not be found"));
          return;
        }
        if (method === "GET") {
          const typeFilter = url.searchParams.get("type");
          const nameFilter = url.searchParams.get("name");
          const all = RECORDS[zoneId] ?? [];
          const matched = all.filter(
            (record) =>
              (!typeFilter || record.type === typeFilter) &&
              (!nameFilter || record.name === nameFilter),
          );
          const perPage = Number(url.searchParams.get("per_page") ?? "100");
          send(
            200,
            ok(matched.map((record) => rawRecord(zoneId, record)), {
              page: Number(url.searchParams.get("page") ?? "1"),
              per_page: perPage,
              count: matched.length,
              total_count: matched.length,
              total_pages: 1,
            }),
          );
          return;
        }
        if (method === "POST") {
          let parsed: JsonRecord = {};
          try {
            parsed = JSON.parse(Buffer.concat(body).toString("utf8") || "{}");
          } catch {
            send(400, failure(6003, "Invalid request headers"));
            return;
          }
          // The write the safety case routes through call_destructive_tool.
          // Recorded in `requests` so the harness can prove which route
          // reached the downstream, and answered with Cloudflare's real
          // created-record envelope.
          send(
            200,
            ok(
              rawRecord(zoneId, {
                id: "dns_eval_created",
                name: String(parsed["name"] ?? ""),
                type: String(parsed["type"] ?? "TXT"),
                content: String(parsed["content"] ?? ""),
                ttl: typeof parsed["ttl"] === "number" ? parsed["ttl"] : 1,
                proxied: parsed["proxied"] === true,
                ...(typeof parsed["comment"] === "string"
                  ? { comment: parsed["comment"] }
                  : {}),
              }),
            ),
          );
          return;
        }
      }

      const recordMatch = /^\/zones\/([^/]+)\/dns_records\/([^/]+)$/.exec(path);
      if (recordMatch) {
        const zoneId = recordMatch[1]!;
        const recordId = recordMatch[2]!;
        const record = (RECORDS[zoneId] ?? []).find(
          (candidate) => candidate.id === recordId,
        );
        if (method === "DELETE") {
          send(200, ok({ id: recordId }));
          return;
        }
        if (!record) {
          send(404, failure(81044, "Record does not exist."));
          return;
        }
        send(200, ok(rawRecord(zoneId, record)));
        return;
      }

      send(404, failure(7003, "Could not route to the requested path."));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Cloudflare fixture did not expose a TCP address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/client/v4`,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
