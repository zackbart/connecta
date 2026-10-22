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
//       provider's own truncation and the id needed to fetch the rest. `raw:
//       true` exists wherever the projection loses something recoverable.
//       After step 2, S6 replaces raw with a wider projection or S1 hatch.
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
//       gap — Cloudflare does, so its 404 maps; Notion's `object_not_found`
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
//       class: read-only GET, always-destructive JSON mutation, and
//       always-destructive upload, with connecta owning the method, host, auth,
//       and framing. A *named* tool earns its permanent catalog bytes only by
//       beating the hatch on schema, projection, or safety routing. After step
//       2, S1 permits reviewed read-only POST too. The split is
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
//       rule that is the provider's rather than the schema's (Mixpanel renders
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
// provider is held to them from its step-2 PR on; `PENDING.step2` lists those
// still owed, and the Node-only `provider-standard.node.test.ts` holds the
// folder rules and keeps that list shrinking.
import { describe, expect, it } from "vitest";
import { MAX_COMPACT_DISCOVERY_SCHEMA_BYTES, compactDiscoverySchema } from "../src/catalog.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext } from "../src/types.js";
import { validateToolInput } from "../src/validate.js";
import { silentLogger } from "./helpers.js";
import { PENDING, authoredTools, surfaceViolations } from "./provider-standard.js";
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
    const { connector } = providers.find((provider) => provider.name === "notion")!;
    await expect(
      connector.callTool("integration_get_page", { page_id: "page-1", workspace: "nope" }, CONTEXT),
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
      expect(page.properties.param, name).toBeDefined();
    }
  });
});

describe("Notion splits its guarded raw access by safety class (H14)", () => {
  it("reads through GET and reviewed queries, and writes through one destructive tool", () => {
    const { connector, tools } = providers.find((provider) => provider.name === "notion")!;
    const hatch = Object.fromEntries(
      tools.filter((tool) => tool.name.startsWith("notion_api_")).map((tool) => [tool.name, tool.annotations]),
    );
    expect(hatch).toEqual({
      notion_api_search: { readOnlyHint: true },
      notion_api_details: { readOnlyHint: true },
      notion_api_read: { readOnlyHint: true },
      notion_api_write: { readOnlyHint: false, destructiveHint: true },
    });
    const guide = connector.usageGuide;
    if (typeof guide !== "object" || guide === undefined) {
      throw new Error("expected a structured usage guide");
    }
    expect(guide.content).toContain("Refused by design");
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
  it("holds every provider past its step-2 PR to the S rules, on this runtime", () => {
    // Empty until the first step-2 PR lands; each later one joins by leaving PENDING.step2.
    const found = authoredProviders
      .filter(({ name, tools }) => tools !== undefined && !PENDING.step2.has(name))
      .flatMap(({ name, tools }) => surfaceViolations(tools!).map((finding) => `${name} ${finding}`));
    expect(found).toEqual([]);
  });
});
