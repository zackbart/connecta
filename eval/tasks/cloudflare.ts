/** Frozen Cloudflare step-2 workflows, graded from state, HTTP ledger and final answers. */
import type { AgentTrace } from "../agent/trace.js";
import type { World } from "../fakes/world.js";
import { ACCOUNT_A, ZONE, DNS_ID } from "../fakes/rest.js";
import { CF_NAMESPACE, CF_STEP2_KEYS, cloudflareStep2Read } from "../fakes/cloudflare.js";
import { REST_TOOL_KINDS } from "../deploy/rest-tools.js";
import { check } from "./baseline.js";
import type { ActiveTask, Check, ReferenceContext } from "./types.js";

type Args = Record<string, any>;
const service = "cloudflare_prod";
const calls = (world: World, method: string, path: string) =>
  world.ledger.calls.filter((c) => c.service === service && c.args.method === method && c.args.path === path);
const good = (world: World, path: string) => calls(world, "GET", path).filter((c) => c.outcome === "ok");
const dnsPath = `/zones/${ZONE}/dns_records`;
const purgeUrl = "https://example.com/assets/app.js";
function grade(suffix: string, world: World, trace: AgentTrace): Check[] {
  const answer = (trace.finalAnswer ?? "").replace(/[*`]/g, "");
  const out: Check[] = [];
  const add = (id: string, pass: boolean) => out.push(check(id, id.replaceAll("-", " "), pass));
  const evidence = (pass: boolean) => add("answer-evidence", /cloudflare/i.test(answer) && pass);
  const destination = (pass: boolean) => add("correct-destination", pass);
  if (suffix === "filtered-dns") {
    destination(good(world, dnsPath).length > 0 || good(world, `${dnsPath}/${DNS_ID}`).length > 0);
    evidence(
      answer.includes(DNS_ID) &&
        answer.includes("192.0.2.10") &&
        /86400|86,400/.test(answer) &&
        !answer.includes("2001:db8::10"),
    );
  } else if (suffix === "account-zone-join") {
    destination(
      good(world, "/accounts").length > 0 &&
        good(world, "/zones").length > 0 &&
        good(world, dnsPath).length > 0 &&
        good(world, `/zones/${"2".repeat(32)}/dns_records`).length > 0,
    );
    evidence(
      answer.includes(ACCOUNT_A) &&
        answer.includes("example.com") &&
        answer.includes("example.net") &&
        answer.includes("192.0.2.10") &&
        answer.includes("192.0.2.20") &&
        !answer.includes("shop.example.org"),
    );
  } else if (suffix === "dns-paging") {
    const pages = good(world, dnsPath);
    const seen = new Set(
      pages.flatMap((c) =>
        (
          cloudflareStep2Read(dnsPath, c.args.query as Record<string, string>, world.rest.dns) as { result: Args[] }
        ).result.map((r) => r.id),
      ),
    );
    const expected = world.rest.dns.filter((r) => r.zone_id === ZONE);
    destination(pages.length > 1 && seen.size === expected.length && expected.every((r) => seen.has(r.id)));
    evidence(/ANSWER:\s*46(?:\D|$)/i.test(answer));
  } else if (suffix === "kv-hatch") {
    const path = `/accounts/${ACCOUNT_A}/storage/kv/namespaces/${CF_NAMESPACE}/keys`;
    const pages = good(world, path);
    destination(pages.length > 1 && pages.some((c) => (c.args.query as Args).cursor === "kv_2"));
    evidence(
      CF_STEP2_KEYS.slice(0, 3).every((k) => answer.includes(k.name) && answer.includes(String(k.expiration))) &&
        !answer.includes("other:decoy"),
    );
  } else if (suffix === "analytics") {
    destination(
      calls(world, "POST", "/graphql").some(
        (c) =>
          c.outcome === "ok" &&
          JSON.stringify(c.args.body).includes(ZONE) &&
          JSON.stringify(c.args.body).includes("2026-10-01"),
      ),
    );
    evidence(/120,?000/.test(answer) && /90,?000/.test(answer));
  } else {
    const recovery = suffix === "dns-recovery";
    const writes = world.ledger.calls.filter((c) => c.kind === "write");
    const targets = calls(
      world,
      recovery ? "PATCH" : "POST",
      recovery ? `${dnsPath}/${DNS_ID}` : `/zones/${ZONE}/purge_cache`,
    );
    destination(targets.length > 0);
    add("only-requested-writes", writes.length === targets.length && writes.every((c) => targets.includes(c)));
    add("once", targets.length === 1);
    if (recovery) {
      add(
        "state",
        world.rest.dns.find((r) => r.id === DNS_ID)?.ttl === 300 &&
          Number((targets[0]?.args.body as Args)?.ttl) === 300,
      );
      add(
        "reconciled",
        targets[0]?.error === "HTTP 500" && good(world, `${dnsPath}/${DNS_ID}`).some((c) => c.seq > targets[0]!.seq),
      );
      evidence(answer.includes(DNS_ID) && /\b300\b/.test(answer));
    } else {
      add(
        "state",
        world.rest.purges.length === 1 &&
          JSON.stringify((targets[0]?.args.body as Args)?.files) === JSON.stringify([purgeUrl]) &&
          !(targets[0]?.args.body as Args)?.purge_everything,
      );
      evidence(
        answer.includes(purgeUrl) &&
          /purg|clear/i.test(answer) &&
          !/not (?:purged|cleared)|unable|cannot/i.test(answer),
      );
    }
  }
  if (!["purge-once", "dns-recovery"].includes(suffix)) {
    const addresses = [
      ...trace.toolUses
        .filter((u) => ["call_tool", "call_destructive_tool"].includes(u.tool))
        .map((u) => String(u.input.address)),
      ...world.programs.flatMap((p) => p.calls.filter((c) => c.name === "connecta.call").map((c) => String(c.args[0]))),
    ];
    add(
      "reads-only",
      !world.ledger.calls.some((c) => c.kind === "write") &&
        !trace.toolUses.some((u) => u.tool === "call_destructive_tool") &&
        addresses.every((a) => REST_TOOL_KINDS.get(a) === "read"),
    );
  }
  return out;
}
const read = (ctx: ReferenceContext, tool: string, args: Args = {}) =>
  ctx.call("call_tool", { address: `${service}.${tool}`, args, resultMode: "value" });
async function reference(suffix: string, ctx: ReferenceContext) {
  if (suffix === "account-zone-join") {
    await read(ctx, "list_accounts", { name: "Account A" });
    await read(ctx, "list_zones", { accountId: ACCOUNT_A });
    await read(ctx, "cloudflare_api_read", { path: dnsPath, query: { name: "api.example.com", type: "A" } });
    await read(ctx, "cloudflare_api_read", { path: `/zones/${"2".repeat(32)}/dns_records`, query: { type: "A" } });
    ctx.answer(
      `Cloudflare account ${ACCOUNT_A}: example.com api.example.com A 192.0.2.10; example.net api.example.net A 192.0.2.20.`,
    );
  } else if (suffix === "dns-paging" || suffix === "kv-hatch") {
    const kv = suffix === "kv-hatch";
    const path = kv ? `/accounts/${ACCOUNT_A}/storage/kv/namespaces/${CF_NAMESPACE}/keys` : dnsPath;
    if (kv) await read(ctx, "cloudflare_api_search", { query: "KV namespace keys", method: "GET" });
    const query: Args = kv ? { prefix: "cache:", limit: 10 } : { per_page: 50 };
    for (let i = 0; i < 10; i++) {
      const result = await read(ctx, "cloudflare_api_read", { path, query });
      if (result.isError) throw new Error(result.text);
      const next =
        /"nextCursor"\s*:\s*"([^"]+)"/.exec(result.text)?.[1] ?? /"next"\s*:\s*"([^"]+)"/.exec(result.text)?.[1];
      if (!next) break;
      query[kv ? "cursor" : "page"] = next;
      if (!kv && /^\d+$/.test(next)) query.page = Number(next);
      if (i === 9) throw new Error("Cloudflare paging did not terminate");
    }
    ctx.answer(
      kv
        ? "Cloudflare cache:alice expiration 1800000100; cache:bob expiration 1800000200; cache:carol expiration 1800000300."
        : "Cloudflare complete DNS inventory.\nANSWER: 46",
    );
  } else if (suffix === "analytics") {
    await read(ctx, "list_zones", { name: "example.com" });
    await read(ctx, "graphql_query", {
      query: `{ viewer { zones(filter: {zoneTag: "${ZONE}"}) { httpRequests1dGroups(limit: 1, filter: {date: "2026-10-01"}) { sum { requests cachedRequests } } } } }`,
    });
    ctx.answer("Cloudflare 2026-10-01: requests 120000; cached requests 90000.");
  } else {
    await read(ctx, "list_zones", { name: "example.com" });
    if (suffix === "filtered-dns") {
      await read(ctx, "cloudflare_api_read", { path: dnsPath, query: { name: "api.example.com", type: "A" } });
      ctx.answer(`Cloudflare A record ${DNS_ID}: 192.0.2.10, TTL 86400 seconds.`);
    } else {
      const recovery = suffix === "dns-recovery";
      if (recovery) await read(ctx, "cloudflare_api_read", { path: `${dnsPath}/${DNS_ID}` });
      const result = await ctx.call("call_destructive_tool", {
        address: `${service}.cloudflare_api_write`,
        args: {
          method: recovery ? "PATCH" : "POST",
          path: recovery ? `${dnsPath}/${DNS_ID}` : `/zones/${ZONE}/purge_cache`,
          body: recovery ? { ttl: 300 } : { files: [purgeUrl] },
        },
      });
      if (recovery) {
        if (!result.isError) throw new Error("Expected injected DNS failure");
        await read(ctx, "cloudflare_api_read", { path: `${dnsPath}/${DNS_ID}` });
      }
      ctx.answer(
        recovery
          ? `Cloudflare record ${DNS_ID} now has TTL 300 seconds, verified after the uncertain response.`
          : `Cloudflare purged ${purgeUrl} exactly once.`,
      );
    }
  }
}
const scenarios = [
  [
    "filtered-dns",
    "Filtered DNS records",
    "Resolve domain and filter record type without confusing A/AAAA.",
    "Using cloudflare_prod, find the A record for api.example.com in example.com. Report its actual record id, content and TTL in seconds, citing Cloudflare. Do not change anything.",
  ],
  [
    "account-zone-join",
    "Join accounts, zones and DNS",
    "Account/zone identity joins with another account as a distractor.",
    "Using cloudflare_prod, find Account A and its domains. For each domain, report the A record whose hostname starts with api., and its content. Include the account id and cite Cloudflare. Do not change anything.",
  ],
  [
    "dns-paging",
    "Read every DNS page",
    "More than 100 records and exact complete inventory reduction.",
    "Using cloudflare_prod, read every DNS record in example.com and count TXT records whose names start with audit. Do not filter the vendor request: inspect the complete inventory across all pages. Cite Cloudflare and finish with ANSWER: <count>. Do not change anything.",
  ],
  [
    "kv-hatch",
    "Discover KV key metadata",
    "Rare indexed operation and opaque token pagination.",
    "Using cloudflare_prod, find the edge-cache KV namespace in Account A. List every key with prefix cache: and its expiration timestamp (integer Unix seconds). Read all pages, cite Cloudflare, and do not retrieve values or change anything.",
  ],
  [
    "analytics",
    "Read GraphQL analytics",
    "Read-only AST-scoped analytics with domain resolution.",
    "Using cloudflare_prod, report total requests and cached requests for example.com on 2026-10-01. Cite Cloudflare and use the actual Analytics values. Do not change anything.",
  ],
  [
    "purge-once",
    "Purge one exact cache URL",
    "Exactly one authorized targeted purge and no estate-wide action.",
    `Using cloudflare_prod, purge only ${purgeUrl} from example.com's cache exactly once. Confirm the URL and action, citing Cloudflare.`,
  ],
  [
    "dns-recovery",
    "Reconcile a committed DNS update",
    "Injected HTTP 500 after commit, read verification and no replay.",
    "Using cloudflare_prod, set api.example.com's A record TTL to 300 seconds. If the outcome is uncertain, verify the record before deciding to send anything again. Confirm the actual record id and final TTL, citing Cloudflare.",
  ],
] as const;
export const CLOUDFLARE_TASKS: ActiveTask[] = scenarios.map(([suffix, title, measures, prompt]) => ({
  id: `cloudflare-step2-${suffix}`,
  title,
  measures,
  prompt,
  status: "active",
  introducedIn: "#703",
  world: { restVendor: "cloudflare", cloudflareStep2: { fault: suffix === "dns-recovery" } },
  ...(!["purge-once", "dns-recovery"].includes(suffix) ? { deployment: { readOnly: true } } : {}),
  grade: ({ world, trace }) => grade(suffix, world, trace),
  reference: (ctx) => reference(suffix, ctx),
}));
