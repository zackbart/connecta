// The mechanically checkable half of the hand-written provider conventions,
// run against the shipped surface rather than against the source.
//
// H1–H14 and P1–P13 are the convention ids this suite and the provider sources
// cite. This file is where they are defined: hand-written `api()` surfaces are
// audited against H1–H14, hosted-MCP proxies against P1–P13, and applying a
// hand-written convention to a proxy is a category error rather than a finding.
// Each one names the cost it exists to avoid — wrong-tool selection, argument
// retries, discovery tokens, or result size.
//
// Hand-written surfaces (connecta owns every name, schema, description, and
// budget, so a miss is ours):
//
//   H1  Identity is deployment-owned: `id`, a required `purpose` that throws at
//       construction when blank, an optional `title`, and `instructions`
//       appended to the maintained guide, never replacing it. Two instances of
//       one provider are told apart only by title and guide summary.
//   H2  Names are snake_case `verb_object`, and the leading verb is the safety
//       class — a read never opens with a write verb, a write never hides
//       behind a neutral one. Escape hatches are `<provider>_api_<class>`. Name
//       and description are the only things lexical search indexes; `id` and
//       `title` are displayed, not indexed.
//   H3  Sentence one is complete inside 160 characters, the whole description
//       inside 240 — the budgets search and describe cut at, so anything past
//       them is delivered only to a caller that pays for a second, larger read.
//   H4  The description names the disqualifier, not the pitch: say what the
//       tool will not do wherever an agent would assume it does. One clause of
//       honest negative space beats three of capability. (Review-only.)
//   H5  Input schemas are hand-written, closed (`additionalProperties: false`),
//       with an accurate `required` list, an `enum` on every constrained field,
//       explicit numeric and string bounds, and a description on every property
//       at every depth — nested objects and array items included, because a
//       caller composing an array element reads that element's fields. `api()`
//       refuses to construct a schema its validator cannot enforce.
//   H6  A local bound says whose bound it is: the description states when a cap
//       is the provider's and when it is narrower, because an unexplained
//       refusal reads as a bug and gets retried. (Review-only.)
//   H7  The common path's compact input and output renders stay inside 1,024
//       bytes and each constraint annotation inside 256. Where an enum honestly
//       cannot fit, truncation is acceptable only if name and description
//       already carry enough to *choose* the tool, leaving expansion for the
//       call.
//   H8  Every tool declares an `outputSchema`, so `outputKeys` exist and a
//       program can project a result without first fetching one to look at.
//   H9  Every read projects — the payload flattened, renamed, plan and
//       presentation noise dropped — and surfaces what it dropped, including a
//       provider's own truncation and the id needed to fetch the rest. S6
//       recovers omitted data through a wider projection or S1 hatch.
//   H10 One pagination convention per connector: an explicit page argument, an
//       opaque cursor passed back verbatim, a default page size below the
//       provider maximum, and exactly one branchable `hasMore`-shaped signal.
//       An endpoint that paginates differently says so in schema and guide.
//   H11 Errors are mapped to what the caller does next, never to the provider's
//       name for the cause: `retryAfterMs` where the provider states a wait, a
//       message that states an ambiguity rather than picking the convenient
//       reading, a local `invalid_args` refusal for a call that can only fail,
//       and never a classification invented from provider prose. `not_found`
//       applies only where the provider distinguishes absence from a permission
//       gap — Cloudflare does, so its 404 maps; a vendor's `object_not_found`
//       does not, so the honest code stays `connector_call_failed` (or
//       `auth_required` where a credential really is the fix). It never appears
//       on the proxy path, because P1 forbids re-shaping downstream framing.
//   H12 One operator credential slot with a labeled field per secret, and a
//       `testCredential`/`testCredentials` that makes the cheapest call proving
//       the secret is live and reports the identity or workspace it reached.
//       Nothing probes a credential behind the operator's back.
//   H13 The guide carries only what a schema cannot: structured `usageGuide`
//       with `content` and an explicit `summary`, `required: true` only when
//       correct use depends on a sequence or convention no complete schema can
//       express, first content line the routing fact (it is the summary
//       fallback), and nothing restating a schema.
//   H14 Guarded raw access is accepted, not required — a finite surface may
//       deliberately have none and say so. Where it exists it splits by safety
//       class: reviewed reads, always-destructive JSON mutation, and
//       always-destructive upload, with connecta owning the method, host, auth,
//       and framing. A *named* tool earns its permanent catalog bytes only by
//       beating the hatch on schema, projection, or safety routing. S1 permits
//       reviewed read-only POST. The split is
//       mechanical, that judgment is review-only.
//
// Hosted-MCP proxies (the downstream owns names, descriptions, schemas, result
// shapes, pagination, and error prose; conventions legislating those would be
// fiction, so these cover what connecta does own):
//
//   P1  Normalize by adding, never by rewriting. A proxy may add annotations, a
//       title, a guide, and an admission policy; it does not rewrite a
//       downstream name, description, or schema, and does not re-shape a
//       result. The catalog must stay a true report of what the downstream
//       accepts.
//   P2  Identical to H1: `id`, required `purpose`, optional `title`, and
//       `instructions` appended to the guide — and never able to change the
//       safety classification.
//   P3  The fact that decides routing — production versus sandbox, read-only
//       versus read-write, region, account — appears in the default `title` and
//       as the guide's first content line. It may also appear in the
//       description; never only there, because search never returns it.
//   P4  Endpoint selection is a constructor option whose default is the safe
//       one. Where the provider publishes one endpoint and the environment
//       rides the credential, the mode is required with no default and
//       construction throws when a recognizable credential contradicts it.
//       Deprecated transports stay unreachable.
//   P5  Classification is a reviewed allowlist that fails closed: reads listed
//       by name, writes listed with their destructive verdict, anything
//       unlisted not read-only. The lists are deliberate supersets, since
//       hosted catalogs vary by plan and flag. A release-reviewed destructive
//       verdict outranks a contradictory `readOnlyHint: true`; an additive
//       write leaves `destructiveHint` unset.
//   P6  The guide says the catalog is not a fixed set: search this connector
//       for what the workspace actually exposes, and expect absence in the
//       plan- or beta-gated areas it names.
//   P7  The guide carries the reduction advice no schema can, because a proxy
//       cannot project: page with the cursor rather than raising page size,
//       reduce inside `execute_code` before returning, and state any rendering
//       rule that is the provider's rather than the schema's (a provider renders
//       an absent boolean as `false` in a breakdown).
//   P8  Identity resolution comes before action: where writes take ids, the
//       guide names the read tools that produce them and says not to guess, and
//       says which of a human-readable identifier and a UUID is which.
//   P9  Authentication defaults to per-instance OAuth in connector-scoped
//       storage. A headless credential is supported as explicit `headers` auth
//       or as `{ type: "credential" }` with an operator slot, framed the way
//       the provider's *published* MCP contract frames it, paired with the
//       narrowest mode, with `requireHttps` set. Recovery is the ordinary
//       `auth_required` → `authorize_connector` route; never advertise a route
//       the deployment's mounted modules cannot serve.
//   P10 Nothing probes a credential unasked. A proxy declares a slot exactly
//       when auth is `{ type: "credential" }`, and then inherits H12 whole:
//       `testCredential` runs only from the operator's Test action — no timer,
//       no warmup, no check on a read path — and reports how many tools the
//       downstream served, which is the whole honest check for a proxy. The
//       other two shapes pay H12 through P4's construction-time contradiction
//       check and a loud `auth_required` at use.
//   P11 Connecta classifies the transport; the downstream owns the tool error.
//       An authorization failure, a session teardown, a timeout, and a
//       capability the proxy will not relay become explicit refusals; a
//       downstream tool-level failure is passed back as it arrived, never
//       repackaged as `invalid_args` (the proxy has no schema of its own to
//       have validated against) and never classified from its prose.
//   P12 Declare an admission budget only when the provider documents a number,
//       and say in the guide that it is a per-runtime approximation rather than
//       an enforcement. Where nothing is published, or the limit is metered per
//       user, declare none and document how an operator supplies one. A
//       `maxConcurrency` beside a budget is labeled as connecta's choice.
//   P13 A drifting downstream must be visible, not absorbed: one classification
//       structure per provider, built once by `vettedCatalog()` and used both
//       to classify and to compare, so the annotation a caller gets and the
//       verdict the drift check reads can never disagree. Drift surfaces as a
//       loud unclassified tool on the approval path, never a quiet re-guess.
//
// This suite decides H2, H3, H5, H7, H8, H10, H12, H13, and H14's split for the
// hand-written `api()` providers. H1, H9, and H11 are mechanical too but are decided in
// each provider's own suite, where the mapped statuses and projections live, and
// P1–P13 likewise in the proxies' suites: their bar is about the wrapper's
// identity and classification, not about tool shapes it does not own. H4, H6,
// and H14's earns-its-place judgment are readings, not assertions.
//
// A provider that later needs an exception adds it to the recorded lists here
// with its argument, so an accepted miss stays visible instead of quietly
// widening the bar for everyone ([#342](https://github.com/zackbart/connecta/issues/342)).
//
// Decision 0011's provider standard adds S1–S6, one agent-facing shape across
// api() surfaces (hatch names, paging, result envelope, errors, `fields`, and
// privacy as deployment config), defined in `test/provider-standard.ts`. A
// provider meets these rules, and the Node-only
// `provider-standard.node.test.ts` enforces the folder rules.
import { describe, expect, it } from "vitest";
import { MAX_COMPACT_DISCOVERY_SCHEMA_BYTES, compactDiscoverySchema } from "../src/catalog.js";
import { RESPONSE_BUDGET } from "../src/http/hatch-response.js";
import { canonicalJson } from "../src/canonical-json.js";
import { expectRedactedOnRead, populated, readWorld, valuesAt } from "./fixtures/provider-reads.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext } from "../src/types.js";
import { validateToolInput } from "../src/validate.js";
import { silentLogger } from "./helpers.js";
import { authoredTools, surfaceViolations } from "./provider-standard.js";
import { authoredFixtures, providerFixtures, providerKinds } from "./providers.generated.js";

const CONTEXT: ConnectorContext = {
  storage: memoryStorage(),
  logger: silentLogger,
  baseUrl: "https://connecta.example",
  credential: {
    get: async () => "token",
    getAll: async () => ({ value: "token", email: "operator@example.com" }),
  },
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

const providers = await Promise.all(
  providerFixtures
    .filter((fixture) => fixture.conventions !== undefined)
    .map(async (fixture) => {
      const connector = fixture.create();
      return {
        name: fixture.name,
        connector,
        tools: await connector.listTools(CONTEXT),
        conventions: fixture.conventions!,
      };
    }),
);

describe.each(providers)("$name meets the hand-written provider conventions", ({ connector, tools, conventions }) => {
  it("gives every tool a closed, required-listing top-level schema (H5)", () => {
    const gaps: string[] = [];
    for (const tool of tools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      if (schema["type"] !== "object") gaps.push(`${tool.name}: not an object`);
      if (schema["additionalProperties"] !== false) {
        gaps.push(`${tool.name}: open`);
      }
      if (!Array.isArray(schema["required"])) {
        gaps.push(`${tool.name}: no required list`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it("keeps every compact input and output render inside the budget (H7)", () => {
    const oversized: string[] = [];
    for (const tool of tools) {
      for (const [kind, schema] of [
        ["input", tool.inputSchema],
        ["output", tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        const rendered = compactDiscoverySchema(schema);
        const bytes = utf8Length(rendered.text);
        if (bytes > MAX_COMPACT_DISCOVERY_SCHEMA_BYTES || rendered.truncated) {
          oversized.push(`${tool.name} ${kind}: ${bytes} bytes`);
        }
      }
    }
    expect(oversized).toEqual([]);
  });

  it("declares an output schema on every tool (H8)", () => {
    const undeclared = tools.filter((tool) => tool.outputSchema === undefined).map((tool) => tool.name);
    expect(undeclared).toEqual([]);
    const paged = tools.filter((tool) => {
      const page = (tool.outputSchema as any)?.properties?.page;
      const more = page?.properties?.hasMore;
      return page && more?.const !== false && !(more?.enum?.length === 1 && more.enum[0] === false);
    });
    const guide = connector.usageGuide;
    if (paged.length && typeof guide === "object") {
      const lines = guide.content.split("\n").filter((line) => line.startsWith("- **Paging:**"));
      expect(lines.length).toBeGreaterThan(0);
      // Conditional product groups may supply separate paging lines. Each
      // reachable paged tool still gets exactly one continuation instruction.
      for (const tool of paged)
        expect(
          lines.filter((line) => line.includes(`\`${tool.name}\``)),
          tool.name,
        ).toHaveLength(1);
      const line = lines.join("\n");
      for (const tool of tools.filter((tool) => (tool.outputSchema as any)?.properties?.page && !paged.includes(tool)))
        expect(line).not.toContain(`\`${tool.name}\``);
      for (const tool of paged) {
        if (!(tool.inputSchema as any)?.properties?.cursor)
          expect(line).toContain(`For \`${tool.name}\`, put it in \`query[page.param]\` or \`body[page.param]\``);
      }
      expect(line).toContain("before the call that would exceed it and continue in the next program; don't restart");
    }
  });

  it("declares an operator credential and a test for it (H12)", () => {
    if (conventions.auth === "delegated") {
      expect(connector.credential).toBeUndefined();
      expect(connector.startAuth).toBeUndefined();
      expect(connector.testCredential ?? connector.testCredentials).toBeUndefined();
      return;
    }
    if (conventions.auth === "oauth") {
      expect(connector.credential).toBeUndefined();
      expect(connector.startAuth).toBeInstanceOf(Function);
      return;
    }
    expect(connector.credential).toBeDefined();
    expect(connector.testCredential ?? connector.testCredentials).toBeInstanceOf(Function);
  });
});

describe("hand-written providers refuse schemas they cannot enforce (H5)", () => {
  it("ships no schema the validator cannot evaluate", () => {
    // Fail-closed schema handling is the package default: an unevaluable
    // schema is refused at construction, and one that only reveals itself on
    // first use fails that call rather than forwarding the arguments. That is
    // only a good trade if no shipped schema is unevaluable, so this asserts
    // the precondition: an unevaluable schema here would refuse every call to
    // its tool.
    const unevaluable: string[] = [];
    for (const { name, tools } of providers) {
      for (const tool of tools) {
        if (!tool.inputSchema) continue;
        const address = `${name}.${tool.name}`;
        // An empty object, so a failure is about the schema rather than about
        // handing the validator something that is not JSON at all.
        const failure = validateToolInput(
          tool.inputSchema,
          {},
          {
            address,
            logger: silentLogger,
            failClosed: true,
          },
        );
        if (failure?.message.includes("could not be evaluated")) {
          unevaluable.push(address);
        }
      }
    }
    expect(unevaluable).toEqual([]);
  });

  it("refuses an argument the schema does not declare, before any request", async () => {
    // The closed schemas are the whole point of H5: a stray argument is caught
    // locally as `invalid_args` instead of becoming a round trip that fails
    // somewhere inside the provider.
    const { connector } = providers.find((provider) => provider.name === "stripe")!;
    await expect(
      connector.callTool("stripe_api_read", { path: "/v1/account", workspace: "nope" }, CONTEXT),
    ).rejects.toMatchObject({
      code: "invalid_args",
    });
  });
});

describe("Cloudflare states its two pagination conventions in the schema (H10)", () => {
  it("names the page parameter beside every next value", async () => {
    const { tools } = providers.find((provider) => provider.name === "cloudflare")!;
    for (const name of ["cloudflare_api_read", "list_zones", "list_accounts"]) {
      const page = (tools.find((tool) => tool.name === name)!.outputSchema as any).properties.page;
      expect(page.properties.hasMore, name).toBeDefined();
      if (name === "cloudflare_api_read") expect(page.properties.param, name).toBeDefined();
      else expect(page.properties.nextCursor, name).toBeDefined();
    }
  });
});

describe("Stripe splits its guarded raw access by safety class (H14)", () => {
  it("reads through GET and reviewed queries, and writes through one destructive tool", () => {
    const { connector, tools } = providers.find((provider) => provider.name === "stripe")!;
    const hatch = Object.fromEntries(
      tools.filter((tool) => tool.name.startsWith("stripe_api_")).map((tool) => [tool.name, tool.annotations]),
    );
    expect(hatch).toEqual({
      stripe_api_search: { readOnlyHint: true },
      stripe_api_details: { readOnlyHint: true },
      stripe_api_read: { readOnlyHint: true },
      stripe_api_write: { readOnlyHint: false, destructiveHint: true },
    });
    const guide = connector.usageGuide;
    if (typeof guide !== "object" || guide === undefined) {
      throw new Error("expected a structured usage guide");
    }
    expect(guide.content).toContain("refused by design");
  });
});

// The H metadata filter above never decides S coverage. Kinds come from the
// actual definitions, and every authored surface has its own offline fixture.
const authoredProviders = await Promise.all(
  providerFixtures.map(async (fixture) => ({
    name: fixture.name,
    tools: await authoredTools(
      providerKinds[fixture.name]!,
      {
        name: fixture.name,
        ...(authoredFixtures[fixture.name] ? { createAuthored: authoredFixtures[fixture.name]! } : {}),
      },
      CONTEXT,
    ),
  })),
);

describe("standard api() surfaces share one agent-facing shape (decision 0011, S1–S6)", () => {
  it("holds every provider to the S rules, on this runtime", () => {
    const found = authoredProviders.flatMap(({ name, tools }) =>
      surfaceViolations(tools!).map((finding) => `${name} ${finding}`),
    );
    expect(found).toEqual([]);
  });
});

describe("hatch details list selectable response fields, hint withheld ones, and promise nothing (S5)", () => {
  // Valid path and query values for the fixtures: GitHub's App scope names acme/one, Granola
  // ids are not_ plus 14 characters, and QuickBooks company info names the configured realm.
  const filled = (name: string, path: string, param: string, schema: any): string => {
    if (name === "github" && param === "owner") return "acme";
    if (name === "github" && param === "repo") return "one";
    if (name === "granola") return "not_abcdefghij1234";
    if (name === "breeze") return "1";
    if (name === "quickbooks") return path.startsWith("/companyinfo/") ? "123456789" : "42";
    return sample(schema, "fixture1");
  };
  const sample = (schema: any, text: string): any => {
    const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
    if (schema?.enum?.length) return schema.enum[0];
    if (schema?.anyOf?.length) return sample(schema.anyOf[0], text);
    if (type === "integer" || type === "number") return schema.minimum ?? 1;
    if (type === "boolean") return true;
    if (type === "array") return [sample(schema.items, text)];
    if (type === "object")
      return Object.fromEntries(
        (schema.required ?? []).map((key: string) => [key, sample(schema.properties?.[key], text)]),
      );
    if (schema?.format === "date-time") return "2026-01-01T00:00:00Z";
    if (schema?.format === "date") return "2026-01-01";
    return text;
  };
  // Vendors that check an envelope in-band before answering need its real values.
  const fixed: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    breeze: { success: true, errors: null },
    cloudflare: { success: true },
    granola: { hasMore: false, cursor: null, id: "not_abcdefghij1234" },
    overflow: { totalCount: 1 },
    stripe: { has_more: false },
    tithely: { status: "success" },
  };
  // Secret-shaped, and sharing no text with the harness credentials, which sent-secret
  // redaction would rightly take out of any value.
  const secret = (index: number) => `sk_live_51Hq${index}Zx9eR4tY7uI0pA3sD6fGhJ`;
  it.each(providerFixtures.map((fixture) => fixture.name))("%s", { timeout: 120_000 }, async (name) => {
    const world = await readWorld(name);
    const tools = await world.connector.listTools(world.context());
    const details = tools.find((tool) => tool.name.endsWith("_api_details"));
    if (!details) return;
    const schema = (details.outputSchema as any).properties.response.properties;
    expect(schema.fields.description).toMatch(/Not a readability promise: value safety may still withhold or redact/);
    expect(schema.withheld.description).toMatch(/Best-effort hint.*An unlisted path may still be withheld or redacted/);
    const prefix = details.name.replace(/_details$/, "");
    const call = async (tool: string, args: Record<string, unknown>) => {
      const result = (await world.connector.callTool(`${prefix}_${tool}`, args, world.context())) as any;
      return result?.structuredContent ?? result;
    };
    const operations = new Map<string, { method: string; path: string }>();
    for (const query of ["list", "get", "retrieve", "read"]) {
      const found = await call("search", { query, limit: 8 }).catch(() => ({ operations: [] }));
      for (const op of found.operations)
        if (op.tool === `${prefix}_read`) operations.set(`${op.method} ${op.path}`, op);
    }
    let tested = 0;
    const problems: string[] = [];
    // A bounded, deterministic sample: the first eight read operations the searches find.
    for (const { method, path } of [...operations.values()].slice(0, 8)) {
      const contract = await call("details", { method, path });
      const response = contract.response;
      if (!response) continue;
      tested += 1;
      const label = `${method} ${path}`;
      expect(await call("details", { method, path }), label).toEqual(contract);
      const withheld: string[] = response.withheld ?? [];
      expect(new Set(response.fields).size, label).toBe(response.fields.length);
      expect(
        withheld.filter((field) => !response.fields.includes(field)),
        label,
      ).toEqual([]);
      expect(response.fields.length).toBeLessThanOrEqual(RESPONSE_BUDGET.paths);
      expect(response.fields.every((field: string) => field.length <= RESPONSE_BUDGET.pathChars)).toBe(true);
      const args: Record<string, unknown> = {
        ...(method === "GET" ? {} : { method }),
        path: path.replace(/\{([^}]+)\}/g, (_: string, param: string) =>
          filled(name, path, param, contract.parameters.find((entry: any) => entry.name === param)?.schema),
        ),
      };
      const query = Object.fromEntries(
        contract.parameters
          .filter((entry: any) => entry.in === "query" && entry.required)
          .map((entry: any) => [entry.name, sample(entry.schema, "fixture1")]),
      );
      if (Object.keys(query).length) args["query"] = query;
      if (contract.body?.required) {
        const body = contract.body.schema;
        args["body"] = Object.fromEntries(
          (body.required ?? []).map((key: string) => [key, sample(body.properties?.[key], "fixture1")]),
        );
      }
      const body = populated(response, secret, fixed[name]);
      world.serve(body);
      const outcome = (extra: Record<string, unknown>): Promise<{ result?: any; error?: string }> =>
        call("read", { ...args, ...extra }).then(
          (result) => ({ result }),
          (error: any) => ({ error: `${error?.code}: ${error?.message}` }),
        );
      // An undeclared path is refused while the same read without fields is not, so each
      // operation's comparison provably reaches the fields check.
      const control = await outcome({ fields: ["connecta_undeclared"] });
      expect(control.error, label).toMatch(/fields path connecta_undeclared/);
      // Every advertised path is accepted by the real read and selects exactly what the same read
      // returns there without fields; a hinted path really comes back withheld or redacted.
      // Nothing promises the other paths' values.
      const whole = await outcome({});
      if (!whole.result) problems.push(`${label}: ${whole.error}`);
      for (let at = 0; at < response.fields.length; at += 50) {
        const chunk: string[] = response.fields.slice(at, at + 50);
        const read = await outcome({ fields: chunk });
        if (!read.result) {
          problems.push(`${label}: ${read.error}`);
          continue;
        }
        for (const field of chunk) {
          const sent = valuesAt(body, field);
          const got = valuesAt(read.result.data, field);
          if (canonicalJson(got) !== canonicalJson(valuesAt(whole.result?.data, field)))
            problems.push(`${label} ${field}: selects a different value`);
          if (withheld.includes(field) && canonicalJson(got) === canonicalJson(sent))
            problems.push(`${label} ${field}: hinted withheld, read whole`);
        }
      }
    }
    expect(tested).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  // Values the contract never promised, from actual vendor shapes: an expandable, polymorphic or
  // opaque container is selectable, and the real read still redacts what value safety finds in it.
  const ACCOUNT = "0123456789abcdef0123456789abcdef";
  const unwrap = async (result: Promise<unknown>) => {
    const value = (await result) as any;
    return value?.structuredContent ?? value;
  };
  const intent = { id: "pi_1", object: "payment_intent", amount: 500, client_secret: "pi_1_secret_stored" };
  it.each([
    {
      name: "cloudflare",
      template: "/accounts/{account_id}/builds/workers/{script_name}/deploy_hooks",
      path: `/accounts/${ACCOUNT}/builds/workers/edge-worker/deploy_hooks`,
      body: {
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            deploy_hook_uuid: "8c3e1b0a-1d2f-4a5b-9c6d-7e8f9a0b1c2d",
            deploy_hook_name: "main deploys",
            branch: "main",
            created_on: "2026-01-01T00:00:00Z",
          },
        ],
        result_info: { page: 1, per_page: 20, count: 1, total_count: 1 },
      },
      paths: ["result[].deploy_hook_uuid"],
      hinted: ["result[].deploy_hook_uuid", "result"],
      secrets: ["8c3e1b0a-1d2f-4a5b-9c6d-7e8f9a0b1c2d"],
    },
    {
      name: "cloudflare",
      template: "/accounts/{account_id}/logpush/jobs",
      path: `/accounts/${ACCOUNT}/logpush/jobs`,
      body: {
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            id: 7,
            name: "worker traces",
            dataset: "workers_trace_events",
            enabled: true,
            destination_conf:
              "s3://logs-bucket/workers?region=us-east-1&access-key-id=AKIAFIXTURE&secret-access-key=logpush-stored-secret",
          },
        ],
      },
      paths: ["result[].destination_conf"],
      hinted: ["result[].destination_conf"],
      secrets: ["logpush-stored-secret", "AKIAFIXTURE"],
    },
    {
      name: "vercel",
      template: "/v2/integrations/log-drains",
      path: "/v2/integrations/log-drains",
      body: [
        {
          id: "ld_1",
          name: "drain",
          url: "https://drain.example/ingest",
          headers: { "X-Custom": "stored-drain-secret" },
        },
      ],
      paths: ["headers"],
      secrets: ["stored-drain-secret"],
    },
    {
      name: "vercel",
      template: "/v13/deployments/{idOrUrl}",
      path: "/v13/deployments/dpl_1",
      body: { id: "dpl_1", name: "web", readyState: "READY", env: ["API_TOKEN=stored-env-secret"] },
      paths: ["env"],
      secrets: ["stored-env-secret"],
    },
    {
      name: "vercel",
      template: "/v9/projects/{idOrName}",
      path: "/v9/projects/web",
      body: {
        id: "prj_1",
        name: "web",
        protectionBypass: { "bypass-secret-abc123": { createdAt: 1767225600000, scope: "automation-bypass" } },
      },
      // Reviewed as metadata whose keys are secrets: redacting keys depends on the value, so no hint.
      paths: ["protectionBypass"],
      secrets: ["bypass-secret-abc123"],
    },
    {
      name: "stripe",
      template: "/v1/events/{id}",
      path: "/v1/events/evt_1",
      body: { id: "evt_1", object: "event", type: "payment_intent.succeeded", data: { object: intent } },
      paths: ["data"],
      secrets: ["pi_1_secret_stored"],
    },
    {
      name: "stripe",
      template: "/v1/checkout/sessions/{session}",
      path: "/v1/checkout/sessions/cs_1",
      body: { id: "cs_1", object: "checkout.session", mode: "payment", payment_intent: intent },
      paths: ["payment_intent"],
      secrets: ["pi_1_secret_stored"],
    },
    {
      name: "docs",
      template: "/documents/{documentId}",
      path: "/documents/doc_1",
      body: {
        documentId: "doc_1",
        title: "Launch plan",
        inlineObjects: {
          "kix.1": {
            objectId: "kix.1",
            inlineObjectProperties: {
              embeddedObject: {
                imageProperties: {
                  contentUri: "https://lh3.googleusercontent.com/stored-content-capability",
                  sourceUri: "https://images.example/a.png",
                },
              },
            },
          },
        },
      },
      paths: ["inlineObjects"],
      secrets: ["stored-content-capability"],
    },
  ])(
    "$name $template: listed and selectable, yet redacted on read",
    async ({ name, template, path, body, paths, hinted, secrets }) => {
      const world = await readWorld(name);
      world.serve(body);
      await expectRedactedOnRead({
        details: () =>
          unwrap(world.connector.callTool(`${name}_api_details`, { method: "GET", path: template }, world.context())),
        read: (fields) => unwrap(world.connector.callTool(`${name}_api_read`, { path, fields }, world.context())),
        body,
        paths,
        ...(hinted ? { hinted } : {}),
        secrets,
      });
    },
  );
});
