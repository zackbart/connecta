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
//       beating the hatch on schema, projection, or safety routing; the split is
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
import { describe, expect, it } from "vitest";
import {
  MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
  compactDiscoverySchema,
} from "../src/catalog.js";
import { ccb } from "../src/providers/ccb.js";
import { breeze } from "../src/providers/breeze.js";
import { gmail } from "../src/providers/gmail.js";
import { drive } from "../src/providers/drive.js";
import { docs } from "../src/providers/docs.js";
import { sheets } from "../src/providers/sheets.js";
import { slides } from "../src/providers/slides.js";
import { forms } from "../src/providers/forms.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import { notion } from "../src/providers/notion.js";
import { planningCenter } from "../src/providers/planning-center.js";
import { overflow } from "../src/providers/overflow.js";
import { vercel } from "../src/providers/vercel.js";
import { tithely } from "../src/providers/tithely.js";
import { memoryStorage } from "../src/storage/memory.js";
import { validateToolInput } from "../src/validate.js";
import { silentLogger } from "./helpers.js";
import type { Connector, ConnectorContext, ToolDef } from "../src/types.js";

// H3's two budgets, from `src/catalog-service.ts`: search cuts a description at
// 160 characters and describe at 240.
const SELECTION_SENTENCE_BUDGET = 160;
const DESCRIPTION_BUDGET = 240;

const CONTEXT: ConnectorContext = {
  storage: memoryStorage(),
  logger: silentLogger,
  baseUrl: "https://connecta.example",
  credential: {
    get: async () => "token",
    getAll: async () => ({ value: "token", email: "operator@example.com" }),
  },
};

/**
 * The verbs each connector's names may open with. H2 allows a provider its own
 * vocabulary beyond the shared set, so the extra verbs are listed rather than
 * inferred — a new one is a decision, not a typo that slips through.
 */
const VERBS: Readonly<Record<string, readonly string[]>> = {
  cloudflare: [
    "list",
    "get",
    "search",
    "create",
    "update",
    "delete",
    "add",
    "bulk",
    "purge",
    "rollback",
    "write",
    "verify",
    "upload",
    "rename",
    "retry",
    "set",
    // The escape hatches sort together under the provider's own name.
    "cloudflare",
  ],
  notion: [
    "list",
    "get",
    "search",
    "create",
    "update",
    "delete",
    "add",
    "append",
    "query",
    "trash",
  ],
  vercel: [
    "list",
    "get",
    "add",
    "verify",
    "remove",
    "upsert",
    "update",
    "delete",
    "promote",
    "cancel",
    "vercel",
  ],
  ccb: ["list", "get", "ccb"],
  "planning-center": [
    "list",
    "get",
    "search",
    "create",
    "update",
    "add",
    // Refreshing a People list is Planning Center's own verb for it.
    "run",
    "apply",
    "schedule",
    // The escape hatches sort together under Planning Center's own
    // abbreviation, the one its API headers use (`X-PCO-API-Version`).
    "pco",
  ],
  // Reads only: every Overflow write moves money or edits a donor and crosses
  // the destructive mutate hatch rather than a named verb.
  overflow: ["list", "get", "overflow"],
  // Reads only: every Tithe.ly write moves money or donor payment state and
  // stays behind the approval-gated mutate hatch.
  tithely: ["list", "get", "tithely"],
  breeze: [
    "list",
    "get",
    "add",
    "update",
    "assign",
    "unassign",
    "record",
    "breeze",
  ],
  // Draft-only: no verb sends, deletes, or relabels, and there is no hatch.
  gmail: ["search", "list", "get", "create", "update"],
  // No permanent delete: trash is recoverable, and `delete` names only the
  // removal of a share. `restore` is Drive's untrash.
  drive: ["search", "list", "get", "create", "update", "move", "copy", "trash", "restore", "share", "delete"],
  // No search or list: finding a document is Drive's job. "batch" is Google's
  // own name for its raw edit method, documents.batchUpdate.
  docs: ["get", "create", "append", "insert", "replace", "batch"],
  // `batch` opens both multi-range value writes and the raw batchUpdate hatch;
  // both are destructive, so the verb still names one safety class.
  sheets: ["get", "create", "add", "append", "update", "clear", "batch"],
  // The raw hatch keeps Google's own method name, batchUpdate, so an agent
  // that knows the Slides reference finds it by that name.
  slides: ["get", "list", "create", "replace", "batch"],
  // No delete or submit verb; `batch` is Google's own batchUpdate, the one
  // always-destructive hatch, named as the Forms reference names it.
  forms: ["get", "list", "create", "update", "batch"],
};

/**
 * The nested properties allowed to ship without a description, with the
 * argument for the whole set.
 *
 * H5 asks for a description on *every* property, and a check that only walked
 * the top level would have let a nested one through while the audit claimed
 * otherwise. Walking the whole schema leaves exactly these: the request parts
 * of Cloudflare's three escape hatches, where H5 collides with H7. `query` and
 * `headers` are one shared constant the compact renderer inlines into all
 * three hatches, and `cloudflare_api_upload` already renders at 1,007 of the
 * 1,024-byte budget this same audit brought it back under — describing
 * `name`/`value` pairs the parent property has already named as name/value
 * pairs would push it over and truncate the entire tool in discovery. H7 wins
 * on that trade, and the exception is recorded rather than hidden behind a
 * shallower check ([#342](https://github.com/zackbart/connecta/issues/342)).
 *
 * The list is asserted exactly, so a new undescribed nested property fails and
 * so does a stale entry here.
 */
const NESTED_DESCRIPTION_EXCEPTIONS: Readonly<
  Record<string, readonly string[]>
> = {
  cloudflare: [
    "cloudflare_api_get.query[].name",
    "cloudflare_api_get.query[].value",
    "cloudflare_api_get.headers[].name",
    "cloudflare_api_get.headers[].value",
    "cloudflare_api_mutate.query[].name",
    "cloudflare_api_mutate.query[].value",
    "cloudflare_api_mutate.headers[].name",
    "cloudflare_api_mutate.headers[].value",
    "cloudflare_api_upload.query[].name",
    "cloudflare_api_upload.query[].value",
    "cloudflare_api_upload.headers[].name",
    "cloudflare_api_upload.headers[].value",
    "cloudflare_api_upload.fields[].name",
    "cloudflare_api_upload.fields[].value",
    "cloudflare_api_upload.fields[].contentType",
    "cloudflare_api_upload.fields[].fileName",
    "cloudflare_api_upload.files[].name",
    "cloudflare_api_upload.files[].fileName",
    "cloudflare_api_upload.files[].contentType",
    "cloudflare_api_upload.files[].text",
    "cloudflare_api_upload.files[].base64",
  ],
  notion: [],
  vercel: [],
  ccb: [],
  "planning-center": [],
  overflow: [],
  tithely: [],
  breeze: [],
  gmail: [],
  drive: [],
  docs: [],
  sheets: [],
  slides: [],
  forms: [],
};

/**
 * Providers whose auth is `api()`'s downstream OAuth grant rather than an
 * operator credential slot. H12's "one credential, one cheap test" has no slot
 * to test there: the grant is exercised by the consent flow itself, and a dead
 * one fails at use as `auth_required`. What H12 still asks is that the
 * connection declare exactly one way to authenticate.
 */
const OAUTH_PROVIDERS: ReadonlySet<string> = new Set(["ccb"]);

/**
 * Providers authenticated by a delegated Google service account (#678). H12
 * has nothing to hold them to: the key is deployment configuration, read at
 * construction where a structural mistake throws, and the account a call acts
 * as is the caller's own, so a Test button with no caller would prove nothing
 * about anyone's access. A dead grant fails at use with an `auth_required`
 * that names the scopes to authorize. What H12 still asks is one way to
 * authenticate — so neither a credential slot nor an OAuth grant.
 */
const DELEGATED_PROVIDERS: ReadonlySet<string> = new Set(["gmail", "drive", "docs", "sheets", "slides", "forms"]);

interface SchemaNode {
  properties?: Record<string, SchemaNode | undefined>;
  items?: SchemaNode;
  additionalProperties?: unknown;
  description?: string;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
}

/**
 * Collect every property below the top level that H5 would object to.
 *
 * Only nodes that declare `properties` are held to closedness: a deliberate
 * passthrough like Notion's `filter` is an opaque object by design, and
 * closing a shape the provider owns is not connecta's call.
 */
function schemaGaps(
  schema: SchemaNode | undefined,
  path: string,
  gaps: { undescribed: string[]; open: string[] },
): void {
  if (!schema || typeof schema !== "object") return;
  if (schema.properties) {
    if (schema.additionalProperties !== false) gaps.open.push(path);
    for (const [property, definition] of Object.entries(schema.properties)) {
      const at = `${path}.${property}`;
      if (!definition?.description) gaps.undescribed.push(at);
      schemaGaps(definition, at, gaps);
    }
  }
  schemaGaps(schema.items, `${path}[]`, gaps);
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ]) {
    schemaGaps(branch, path, gaps);
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function firstSentence(description: string): string {
  const match = description.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match ? match[0] : description).trim();
}

/** A freshly generated 2048-bit RSA key as the PKCS#8 PEM a JSON key carries. */
async function rsaPrivateKeyPem(): Promise<string> {
  const { privateKey } = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
}

async function surface(
  name: string,
  connector: Connector,
): Promise<{ name: string; connector: Connector; tools: ToolDef[] }> {
  return { name, connector, tools: await connector.listTools(CONTEXT) };
}

const providers = await Promise.all([
  surface(
    "cloudflare",
    cloudflare("cf", {
      purpose: "Edge administration for the production estate",
    }),
  ),
  surface(
    "notion",
    notion("nt", { purpose: "Engineering wiki and roadmap questions" }),
  ),
  surface(
    "vercel",
    vercel("vc", { purpose: "Production web applications" }),
  ),
  surface(
    "ccb",
    ccb("church", {
      purpose: "Pastoral care and group shepherding",
      environment: "production",
      mode: "system",
      access: "read-write",
      clientId: "client",
      clientSecret: "secret",
    }),
  ),
  surface(
    "planning-center",
    planningCenter("pco", { purpose: "Church staff operations" }),
  ),
  surface(
    "overflow",
    overflow("ov", {
      environment: "production",
      purpose: "Church giving, deposits, and recurring gifts",
    }),
  ),
  surface(
    "tithely",
    tithely("tl", { purpose: "Church giving reports", environment: "live" }),
  ),
  surface(
    "breeze",
    breeze("chms", { subdomain: "gracechurch", purpose: "Pastoral care and giving reports" }),
  ),
  surface(
    "gmail",
    gmail("mail", {
      purpose: "Staff email triage and reply drafting",
      serviceAccount: {
        clientEmail: "delegate@project.iam.gserviceaccount.com",
        // A real key, because construction checks it; the catalog signs nothing.
        privateKey: await rsaPrivateKeyPem(),
      },
      subject: () => undefined,
    }),
  ),
  surface(
    "drive",
    drive("files", {
      purpose: "Staff documents and shared drives",
      serviceAccount: {
        clientEmail: "delegate@project.iam.gserviceaccount.com",
        privateKey: await rsaPrivateKeyPem(),
      },
      subject: () => undefined,
    }),
  ),
  surface(
    "docs",
    docs("docs", {
      purpose: "Staff meeting notes and sermon drafts",
      serviceAccount: {
        clientEmail: "delegate@project.iam.gserviceaccount.com",
        privateKey: await rsaPrivateKeyPem(),
      },
      subject: () => undefined,
    }),
  ),
  surface(
    "sheets",
    sheets("sheets", {
      purpose: "Finance and attendance spreadsheets",
      serviceAccount: {
        clientEmail: "delegate@project.iam.gserviceaccount.com",
        privateKey: await rsaPrivateKeyPem(),
      },
      subject: () => undefined,
    }),
  ),
  surface(
    "slides",
    slides("decks", {
      purpose: "Sermon slides and staff meeting decks",
      serviceAccount: {
        clientEmail: "delegate@project.iam.gserviceaccount.com",
        privateKey: await rsaPrivateKeyPem(),
      },
      subject: () => undefined,
    }),
  ),
  surface(
    "forms",
    forms("forms", {
      purpose: "Event registration forms and their responses",
      serviceAccount: {
        clientEmail: "delegate@project.iam.gserviceaccount.com",
        privateKey: await rsaPrivateKeyPem(),
      },
      subject: () => undefined,
    }),
  ),
]);

describe.each(providers)(
  "$name meets the hand-written provider conventions",
  ({ name, connector, tools }) => {
    it("names every tool verb_object in snake_case (H2)", () => {
      const shapes = tools.filter(
        (tool) => !/^[a-z][a-z0-9_]*$/.test(tool.name),
      );
      expect(shapes.map((tool) => tool.name)).toEqual([]);
      const verbs = VERBS[name] ?? [];
      const strangers = tools.filter(
        (tool) => !verbs.includes(tool.name.split("_")[0] ?? ""),
      );
      expect(strangers.map((tool) => tool.name)).toEqual([]);
    });

    it("fits the selection sentence in 160 and the description in 240 (H3)", () => {
      const overLong: string[] = [];
      for (const tool of tools) {
        const description = tool.description ?? "";
        if (firstSentence(description).length > SELECTION_SENTENCE_BUDGET) {
          overLong.push(`${tool.name}: sentence one`);
        }
        if (description.length > DESCRIPTION_BUDGET) {
          overLong.push(`${tool.name}: ${description.length} characters`);
        }
      }
      expect(overLong).toEqual([]);
    });

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

    it("describes every property at every depth, exceptions apart (H5)", () => {
      // Nested properties are properties. Walking only the top level would
      // have passed while `query[].name` and friends shipped undescribed, so
      // the walk goes all the way down and the accepted misses are named.
      const gaps = { undescribed: [] as string[], open: [] as string[] };
      for (const tool of tools) {
        schemaGaps(tool.inputSchema as SchemaNode, tool.name, gaps);
      }
      const expected = [...(NESTED_DESCRIPTION_EXCEPTIONS[name] ?? [])].sort();
      expect(gaps.undescribed.sort()).toEqual(expected);
      // Closedness has no exception at any depth: an open nested object is an
      // argument the validator waves through into the provider.
      expect(gaps.open).toEqual([]);
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
          if (
            bytes > MAX_COMPACT_DISCOVERY_SCHEMA_BYTES ||
            rendered.truncated
          ) {
            oversized.push(`${tool.name} ${kind}: ${bytes} bytes`);
          }
        }
      }
      expect(oversized).toEqual([]);
    });

    it("declares an output schema on every tool (H8)", () => {
      const undeclared = tools
        .filter((tool) => tool.outputSchema === undefined)
        .map((tool) => tool.name);
      expect(undeclared).toEqual([]);
    });

    it("carries a structured guide with a declared summary (H13)", () => {
      const guide = connector.usageGuide;
      expect(typeof guide).toBe("object");
      if (typeof guide !== "object" || guide === undefined) return;
      expect(guide.summary).toBeTruthy();
      // The catalog caps a guide summary at 120 characters; a declared one that
      // overflows is a derived one with extra steps.
      expect(utf8Length(guide.summary ?? "")).toBeLessThanOrEqual(120);
      expect(guide.content).not.toContain("undefined");
    });

    it("declares an operator credential and a test for it (H12)", () => {
      if (DELEGATED_PROVIDERS.has(name)) {
        expect(connector.credential).toBeUndefined();
        expect(connector.startAuth).toBeUndefined();
        expect(connector.testCredential ?? connector.testCredentials).toBeUndefined();
        return;
      }
      if (OAUTH_PROVIDERS.has(name)) {
        expect(connector.credential).toBeUndefined();
        expect(connector.startAuth).toBeInstanceOf(Function);
        return;
      }
      expect(connector.credential).toBeDefined();
      expect(
        connector.testCredential ?? connector.testCredentials,
      ).toBeInstanceOf(Function);
    });
  },
);

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
        const failure = validateToolInput(tool.inputSchema, {}, {
          address,
          logger: silentLogger,
          failClosed: true,
        });
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
    const { connector } = providers.find(
      (provider) => provider.name === "notion",
    )!;
    await expect(
      connector.callTool("get_self", { workspace: "nope" }, CONTEXT),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });
});

describe("Cloudflare states its second pagination convention in the schema (H10)", () => {
  it("says on both ends that the cursor family has no page object", async () => {
    const { tools } = providers.find(
      (provider) => provider.name === "cloudflare",
    )!;
    const cursorTools = [
      "list_zone_rulesets",
      "list_kv_keys",
      "list_r2_buckets",
      "list_r2_objects",
    ];
    for (const name of cursorTools) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      const input = (tool!.inputSchema as any).properties.cursor;
      const output = (tool!.outputSchema as any).properties.nextCursor;
      expect(input.description, name).toContain("pages by cursor");
      expect(output.description, name).toContain("no page object");
      // The branch is one field, and it is not the page object the rest of
      // the connector returns.
      expect((tool!.outputSchema as any).properties.page, name).toBeUndefined();
    }
  });

  it("keeps the page-numbered majority on page.hasMore", async () => {
    const { tools } = providers.find(
      (provider) => provider.name === "cloudflare",
    )!;
    const paged = tools.find((tool) => tool.name === "list_dns_records")!;
    const page = (paged.outputSchema as any).properties.page;
    expect(page.properties.hasMore).toBeDefined();
    expect((paged.inputSchema as any).properties.cursor).toBeUndefined();
  });
});

describe("Notion says it has no escape hatch (H14)", () => {
  it("names the absence in the guide rather than leaving it to be discovered", () => {
    const { connector, tools } = providers.find(
      (provider) => provider.name === "notion",
    )!;
    expect(tools.some((tool) => tool.name.startsWith("notion_api_"))).toBe(
      false,
    );
    const guide = connector.usageGuide;
    if (typeof guide !== "object" || guide === undefined) {
      throw new Error("expected a structured usage guide");
    }
    expect(guide.content).toContain("no guarded raw-REST tool");
  });
});
