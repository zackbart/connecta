// Value safety for every REST vendor (decision 0005): no tool response,
// success or error, returns a credential (API, service, or bypass tokens,
// signing secrets, bearer URLs, private keys, temporary credentials, auth
// headers, authorization verifiers) or a stored secret value (environment
// variables, secret items), unless a reviewed named tool exists to return it.
//
// One mechanism, strongest layer first:
//
// 1. Refuse by operation. `scripts/value-safety.mjs` flags every operation in
//    a vendor's pinned spec whose response may carry one; `providers:spec`
//    commits the result as `value-safety.candidates.json`. Each needs a
//    reviewed verdict in the vendor's `value-safety.ts` table, and the shared
//    harness (`test/fixtures/value-safety.ts`) fails on any flagged operation
//    without one, a stale pin, a verdict for an operation the index lacks, a
//    flagged field no verdict accounts for, or a refusal that reaches
//    transport.
// 2. Reviewed field paths for `redact` verdicts, on every success body the
//    vendor returns (generic tools, HEAD data, named tools, uploads, logs),
//    after any envelope unwrap and before cursors or `select` read it; then
//    resource rules on every object whose type discriminator they name,
//    wherever an expansion, list, or event embeds it.
// 3. A key-name heuristic, defense in depth only, over every body: any
//    subtree under a credential-named key, labelled or typed secret records,
//    environment containers, header rules, and URLs with userinfo or
//    credential query parameters.
// 4. Errors: an operation with a verdict, or whose request accepts a
//    credential-named field, answers failures with the vendor's codes and
//    statuses but never its text (`withholdsErrors`), unless its review
//    found its errors cannot echo a stored secret (`vendorErrors`).
//
// Residual risk, as with Infisical: a secret a person typed into a free-text
// name, description, log line, or identifier is out of scope.
//
// The rules here are the union of the two that preceded them (Cloudflare's
// and Vercel's): every detection either made still redacts. Exemptions are
// never shared: each vendor states its own in its table (`keep`, `urls`,
// `fields`, `scopeMaps`, `envBodies`).
import type { JsonSchema } from "../../../types.js";
import type { Operation, OperationIndex } from "./operation-index.js";

/** What a removed secret reads as. */
export const REDACTED = "[redacted]";

/** Credential vocabulary over normalized names, matched anywhere; mirrors `scripts/value-safety.mjs`. */
export const CREDENTIAL_WORDS = [
  "token",
  "secret",
  "password",
  "passphrase",
  "privatekey",
  "apikey",
  "accesskey",
  "authorization",
  "cookie",
  "signature",
  "jwt",
  "credential",
  "bypass",
  "verifier",
  "devicecode",
  "authcode",
  "keyvalue",
  "invitecode",
  "joincode",
  "claimcode",
  "transfercode",
  "accesscode",
];

/** Credential vocabulary matched at the end of a normalized name; mirrors the script. */
export const CREDENTIAL_SUFFIX =
  /(tokens?|secrets?|passwords?|passphrases?|privatekeys?|apikeys?|authkey|authorization|cookies?|signature|jwts?|credentials?|psks?|streamkeys?|uploadurl|signedurl|jwks?|verifier|devicecode|bypass)$/;

/** Request fields that carry secrets into a vendor without naming a credential: headers, environment values, bindings. */
const INPUT_CONTAINERS = /(envvars|environmentvariables|bindings|headers?)$/;

/** Suffixes of metadata about a credential (ids, prefixes, last four, counts, expiry, scopes); mirrors the script. */
export const METADATA_SUFFIXES = [
  "id",
  "ids",
  "prefix",
  "suffix",
  "lastfour",
  "lastfourchars",
  "count",
  "type",
  "types",
  "name",
  "names",
  "at",
  "expiry",
  "expires",
  "scope",
  "scopes",
  "enabled",
  "changed",
  "protection",
  "details",
  "length",
  "mode",
  "kind",
  "status",
];

/** Exact metadata names that contain a credential word; mirrors the script. */
export const METADATA_NAMES = [
  "partialkeyvalue",
  "partialkey",
  "inputtokens",
  "outputtokens",
  "totaltokens",
  "cachecreationinputtokens",
  "cachereadinputtokens",
  "usedapptoken",
  "includesrefreshtoken",
  "hasauthorizationdetails",
  "tokensdeleted",
  "istokenexpired",
  "tokenclaims",
  "oidctokenclaims",
  "preauthorizationamount",
  "secretrotation",
  "secretssync",
  "strictpasswordprotectionsettings",
  "disjunctiveproductionsecretpolicy",
  "stripesharedpaymenttokenused",
  "bypassall",
  "bypasssystem",
];

/** Keys whose contents are environment variables, whatever their `key` or `type` says. */
const ENV_CONTAINERS = ["env", "envs", "envvar", "envvars", "newenvvar", "oldenvvar", "sharedenvvar", "sharedenvvars"];
const ENV_VALUE_FIELDS = ["value", "vsmValue", "legacyValue", "decryptedValue"];
/** The fields of a labelled or typed secret record that hold what the label names. */
const LABELLED_VALUE_FIELDS = [...ENV_VALUE_FIELDS, "args", "text"];
/** Query parameters that carry a credential in a URL: either rule. */
const URL_PARAM_CONTAINS = /token|secret|password|passwd|signature|^sig$|key|auth|code|jwt|credential|bypass/i;
const URL_PARAM_SUFFIX = /(token|secret|password|passphrase|key|signature|sig|credential|auth|authorization|jwt)$/;
const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** The fields of a header, cookie, or query rule that hold the matched or set value. */
const HEADER_RULE_VALUES = ["value", "values", "args"];
/** Keys whose absolute URL is a route or redirect destination. */
const DESTINATION_KEYS = ["dest", "destination", "location"];
const MAX_DEPTH = 48;

type JsonRecord = Record<string, unknown>;

export type ValueSafetyVerdict =
  | { readonly verdict: "refuse"; readonly reason: string }
  | {
      readonly verdict: "redact";
      readonly reason: string;
      /**
       * Reviewed field paths into the data a tool returns: `a.b` (a list on
       * the way is traversed item by item), `[]` for list items, `{}` or `*`
       * for every value of a map, `@keys` for a map keyed by secrets (keys
       * become placeholders), `[?env]` for list items whose `type` names an
       * environment variable, `[?credential]` for list items labelled with a
       * credential name, `[?header]` for header, cookie, or query rules. A
       * `url:` prefix sanitizes a URL; an `origin:` prefix (or `#url` suffix)
       * keeps only its scheme and host. Every other value at a path becomes
       * `[redacted]`.
       */
      readonly paths: readonly string[];
      /** Reviewed metadata paths the key-name heuristic leaves (children are still checked). */
      readonly keep?: readonly string[];
      /** See the `safe` verdict. */
      readonly errors?: "vendor";
    }
  | {
      readonly verdict: "safe";
      readonly reason: string;
      /** Reviewed metadata paths the key-name heuristic leaves (children are still checked). */
      readonly keep?: readonly string[];
      /**
       * The error policy. By default a reviewed operation's failures carry the
       * vendor's codes and statuses but never its text, which may echo a
       * stored secret. `vendor` is a reviewed exception for operations whose
       * errors cannot: the vendor's text passes (and still meets the
       * sent-secrets matcher).
       */
      readonly errors?: "vendor";
    };

/** One field name reviewed for a whole vendor whose objects repeat across operations (Stripe's). */
interface FieldReview {
  readonly verdict: "redact" | "keep";
  readonly reason: string;
}

/**
 * A reviewed rule for one resource type, applied to every object whose
 * discriminator names it wherever a response embeds it: the top level, a list,
 * a search result, an expansion, an event's `data.object`. Operation verdicts
 * review what an operation returns by shape; resource rules are the backstop
 * for what expansions can put anywhere.
 */
/**
 * When an object is provably unbound (a guest Checkout Session), stated as
 * data so `providers:spec` can hold it to the pinned schema: every binding
 * field the schema has must be listed, in `bindings` or, with a reason, in
 * `unbound`.
 */
interface GuestCondition {
  /**
   * Fields that bind the object to an identity or its saved methods. Each
   * must be absent, null, empty, or one of the listed values that bind
   * nothing (`customer_creation: "if_required"`).
   */
  readonly bindings: Readonly<Record<string, readonly string[]>>;
  /** Identity-named fields that bind nothing (guest prefill or collected details), with the reason. */
  readonly unbound: Readonly<Record<string, string>>;
  /** Fields whose value must be one of these (a Checkout Session's `mode: "payment"`). */
  readonly requires?: Readonly<Record<string, readonly string[]>>;
}

interface ResourceRule {
  readonly reason: string;
  /** Reviewed paths relative to the object, in the operation path language. */
  readonly paths?: readonly string[];
  /**
   * Fields whose string is a payer-facing URL the resource exists to hand out
   * (a guest Checkout page), returned without URL sanitizing: its fragment is
   * opaque state the page needs. With `guest`, only while the object is
   * provably a guest's; otherwise its `withheld` paths go.
   */
  readonly verbatim?: readonly string[];
  readonly guest?: GuestCondition;
  readonly withheld?: readonly string[];
}

/** Deny by default: an object is a guest's only when no binding field holds anything but a reviewed guest value. */
function guestOnly(resource: Readonly<Record<string, unknown>>, guest: GuestCondition): boolean {
  for (const [field, allowed] of Object.entries(guest.bindings)) {
    const value = resource[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string" && allowed.includes(value)) continue;
    return false;
  }
  for (const [field, allowed] of Object.entries(guest.requires ?? {})) {
    const value = resource[field];
    if (typeof value !== "string" || !allowed.includes(value)) return false;
  }
  return true;
}

interface ResourceRules {
  /** The field that names an object's type (Stripe's `object`). */
  readonly key: string;
  /** Sibling fields holding a partial copy of a discriminated object (an event's `previous_attributes`). */
  readonly partials?: readonly string[];
  readonly rules: Readonly<Record<string, ResourceRule>>;
}

export interface ValueSafetyTable {
  /** Display name in refusals. */
  readonly title: string;
  /** The reviewed verdict for every flagged operation, keyed `METHOD /path template`. */
  readonly operations: Readonly<Record<string, ValueSafetyVerdict>>;
  /**
   * Field names reviewed once for the vendor: `redact` wherever the name
   * appears, `keep` as metadata the heuristic leaves wherever it appears
   * (children are still checked). Keyed by the exact field name.
   */
  readonly fields?: Readonly<Record<string, FieldReview>>;
  /** Operations whose whole body is environment variables: every value field goes, `key` or not. */
  readonly envBodies?: RegExp;
  /** Keys whose string-list values are permission scopes (action names under a resource), never secrets. */
  readonly scopeMaps?: readonly string[];
  /** Rules for resource types wherever they appear, for vendors whose objects carry a type discriminator. */
  readonly resources?: ResourceRules;
}

export const refuse = (reason: string): ValueSafetyVerdict => ({ verdict: "refuse", reason });
export const redact = (reason: string, paths: readonly string[], keep: readonly string[] = []): ValueSafetyVerdict => ({
  verdict: "redact",
  reason,
  paths,
  ...(keep.length ? { keep } : {}),
});
export const safe = (reason: string, keep: readonly string[] = []): ValueSafetyVerdict => ({
  verdict: "safe",
  reason,
  ...(keep.length ? { keep } : {}),
});

/** A verdict whose failures keep the vendor's text: reviewed, for operations whose errors echo no stored secret. */
export const vendorErrors = (verdict: ValueSafetyVerdict): ValueSafetyVerdict =>
  verdict.verdict === "refuse" ? verdict : { ...verdict, errors: "vendor" };

/** Paths under each prefix; a `url:` or `origin:` directive stays in front. */
export function under(prefixes: readonly string[], paths: readonly string[]): string[] {
  return prefixes.flatMap((prefix) =>
    paths.map((path) => {
      if (!prefix) return path;
      const directive = /^(?:url|origin):/.exec(path)?.[0] ?? "";
      return `${directive}${prefix}.${path.slice(directive.length)}`;
    }),
  );
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function metadataName(normalized: string): boolean {
  return (
    METADATA_NAMES.includes(normalized) ||
    METADATA_SUFFIXES.some((suffix) => normalized.endsWith(suffix) && normalized !== suffix)
  );
}

/** Vercel's former rule: a credential word anywhere in a name that is not metadata. Its value goes whole. */
function containsCredential(normalized: string): boolean {
  return CREDENTIAL_WORDS.some((word) => normalized.includes(word)) && !metadataName(normalized);
}

/**
 * Whether a key names a credential: a credential word anywhere in a name
 * that is not metadata (Vercel's former rule), or a credential suffix
 * (Cloudflare's).
 */
export function credentialName(name: string): boolean {
  const normalized = normalizedName(name);
  return containsCredential(normalized) || CREDENTIAL_SUFFIX.test(normalized);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A URL without userinfo, credential query parameters, or a credential-looking fragment; anything unparseable is withheld. */
function sanitizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return REDACTED;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = "redacted";
    url.password = "";
    changed = true;
  }
  // A snapshot of the names: setting a parameter while iterating the live list is unsafe.
  for (const name of Array.from(url.searchParams.keys())) {
    if (URL_PARAM_CONTAINS.test(name) || URL_PARAM_SUFFIX.test(name.toLowerCase().replace(/[_-]/g, ""))) {
      url.searchParams.set(name, REDACTED);
      changed = true;
    }
  }
  if (url.hash && /token|secret|key|code|auth/i.test(url.hash)) {
    url.hash = "";
    changed = true;
  }
  // An ordinary URL comes back exactly as the vendor sent it.
  return changed ? url.toString() : value;
}

/**
 * A destination URL reduced to its origin: webhook, drain, and bearer URLs
 * can carry a secret in the path itself (`hooks.slack.com/services/…`), so
 * only the scheme and host come back.
 */
function originOnly(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  // A destination given as several URLs (`{ traces: "https://…" }`) keeps its shape.
  if (Array.isArray(value)) return value.map(originOnly);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, originOnly(item)]));
  if (typeof value !== "string") return REDACTED;
  try {
    const url = new URL(value);
    const bare = (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash && !url.username;
    // Scheme and host, never userinfo; `origin` reads "null" for non-web schemes (s3://).
    const base = `${url.protocol}//${url.host}`;
    return bare ? base : `${base}/${REDACTED}`;
  } catch {
    return REDACTED;
  }
}

/** Every label a record carries for its value: `key`, `name`, or a transform's `target.key`. */
function labelsOf(value: JsonRecord): string[] {
  const labels: string[] = [];
  if (typeof value["key"] === "string") labels.push(value["key"]);
  if (typeof value["name"] === "string") labels.push(value["name"]);
  const target = value["target"];
  if (isRecord(target) && typeof target["key"] === "string") labels.push(target["key"]);
  return labels;
}

/** Whether a record's label names a credential, so its value or args are one. */
function credentialLabelled(value: unknown): boolean {
  return isRecord(value) && labelsOf(value).some(credentialName);
}

/** A header, cookie, or query rule (`request.headers`, `header`, `cookie`, `query`, …). */
function headerLike(value: unknown): boolean {
  return isRecord(value) && typeof value["type"] === "string" && /header|cookie|query/i.test(value["type"]);
}

/** A route-like object: its `headers` are set on requests or responses. */
function routeLike(value: JsonRecord): boolean {
  return ["src", "source", "dest", "destination"].some((key) => key in value);
}

/** Every value of a headers map, or of a list of `{ key, value }` header pairs, withheld. */
function headerValues(value: unknown): unknown {
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).map((name) => [name, REDACTED]));
  if (Array.isArray(value)) {
    return value.map((item) => (isRecord(item) && "value" in item ? { ...item, value: REDACTED } : item));
  }
  return value;
}

/** A credential-named key's value: everything but null goes. */
function withheld(value: unknown): unknown {
  return value === null || value === undefined ? value : REDACTED;
}

/** Every string under a credential-suffixed key, keeping the subtree's shape (Cloudflare's former rule). */
function scrubStrings(value: unknown): unknown {
  if (typeof value === "string") return REDACTED;
  if (Array.isArray(value)) return value.map(scrubStrings);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubStrings(item)]));
  return value;
}

/** One reviewed path, split into segments; `#url` is the same as an `origin:` prefix. */
function parsePath(raw: string): { mode: "redact" | "url" | "origin"; segments: string[] } {
  let path = raw;
  let mode: "redact" | "url" | "origin" = "redact";
  if (path.startsWith("url:")) {
    mode = "url";
    path = path.slice(4);
  } else if (path.startsWith("origin:")) {
    mode = "origin";
    path = path.slice(7);
  }
  if (path.endsWith("#url")) {
    mode = "origin";
    path = path.slice(0, -4);
  }
  const segments = path.split(".").flatMap((part) => {
    if (part === "") return [];
    const match = /^([^[{@]*)((?:\[\??[a-z]*\]|\{\}|@keys)*)$/.exec(part);
    if (!match) return [part];
    const out: string[] = [];
    if (match[1]) out.push(match[1] === "*" ? "{}" : match[1]);
    for (const token of match[2]!.match(/\[\??[a-z]*\]|\{\}|@keys/g) ?? []) out.push(token);
    return out;
  });
  return { mode, segments };
}

const SEGMENT = /^(?:\[\]|\[\?(?:env|credential|header)\]|\{\}|@keys|[^[\]{}@]+)$/;

/** Whether every segment of a reviewed path is in the path language; the harness checks each table. */
export function validPath(raw: string): boolean {
  const { segments } = parsePath(raw);
  return segments.length > 0 && segments.every((segment) => SEGMENT.test(segment));
}

/** Apply one reviewed path to a body in place of its value. */
function applyPath(body: unknown, raw: string): unknown {
  const { mode, segments } = parsePath(raw);
  const step = (current: unknown, index: number): unknown => {
    if (index === segments.length) {
      if (current === undefined || current === null) return current;
      if (mode === "url") return typeof current === "string" ? sanitizeUrl(current) : REDACTED;
      if (mode === "origin") return originOnly(current);
      return REDACTED;
    }
    const segment = segments[index]!;
    if (segment === "[]" || segment === "[?env]" || segment === "[?credential]" || segment === "[?header]") {
      if (!Array.isArray(current)) return current;
      return current.map((item) => {
        if (segment === "[?env]" && !/env/i.test(String(isRecord(item) ? item["type"] : ""))) return item;
        if (segment === "[?credential]" && !credentialLabelled(item)) return item;
        if (segment === "[?header]" && !headerLike(item)) return item;
        return step(item, index + 1);
      });
    }
    // A named segment, a map, or its keys reached through a list applies to every item.
    if (Array.isArray(current)) return current.map((item) => step(item, index));
    if (segment === "{}") {
      if (!isRecord(current)) return current;
      return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, step(item, index + 1)]));
    }
    if (segment === "@keys") {
      if (!isRecord(current)) return current;
      return Object.fromEntries(Object.values(current).map((item, position) => [`${REDACTED} ${position + 1}`, item]));
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return current;
    return { ...current, [segment]: step(current[segment], index + 1) };
  };
  return step(body, 0);
}

/** A reviewed path as the key trail the heuristic walks: list markers dropped, `*` and `{}` match any key. */
function trailOf(path: string): string[] {
  return parsePath(path).segments.filter((segment) => !segment.startsWith("[") && segment !== "@keys");
}

function matches(paths: readonly string[][], trail: readonly string[]): boolean {
  return paths.some(
    (path) => path.length === trail.length && path.every((part, index) => part === "{}" || part === trail[index]),
  );
}

/**
 * The contents of an environment container: every variable loses its value
 * fields whether or not it has a `key` or `type`, a `NAME → value` map (no
 * `key` or `id`, only strings) loses every value, and `NAME=value` strings go.
 */
function scrubEnv(value: unknown, depth: number): unknown {
  if (depth > 32) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" && item.includes("=") ? REDACTED : scrubEnv(item, depth + 1)));
  }
  if (!isRecord(value)) return value;
  const entries = Object.entries(value);
  const map =
    !("key" in value) &&
    !("id" in value) &&
    !ENV_VALUE_FIELDS.some((field) => field in value) &&
    entries.length > 0 &&
    entries.every(([, item]) => typeof item === "string");
  if (map) return Object.fromEntries(entries.map(([key]) => [key, REDACTED]));
  const out: JsonRecord = {};
  for (const [key, item] of entries) {
    // A value is replaced, so the caller can see one exists without reading it.
    if (ENV_VALUE_FIELDS.includes(key)) {
      out[key] = withheld(item);
      continue;
    }
    out[key] = scrubEnv(item, depth + 1);
  }
  return out;
}

/** An operation body that is environment variables: values go, nothing else changes. */
function scrubValues(value: unknown, depth: number): unknown {
  if (depth > 32) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrubValues(item, depth + 1));
  if (!isRecord(value)) return value;
  const out: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ENV_VALUE_FIELDS.includes(key)) out[key] = scrubValues(item, depth + 1);
  }
  return out;
}

/**
 * Apply resource rules to every discriminated object in a body, innermost
 * first, and to the partial copies events carry beside one. Records the
 * reviewed payer-facing URL fields of objects that keep them.
 */
function resourcePass(
  value: unknown,
  resources: ResourceRules,
  verbatim: WeakMap<object, Set<string>>,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => resourcePass(item, resources, verbatim, depth + 1));
  if (!isRecord(value)) return value;
  let out: JsonRecord = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resourcePass(item, resources, verbatim, depth + 1)]),
  );
  const ruleFor = (type: unknown): ResourceRule | undefined =>
    typeof type === "string" && Object.hasOwn(resources.rules, type) ? resources.rules[type] : undefined;
  // An event's `previous_attributes` is a partial copy of `data.object`: every reviewed path applies to it.
  const inner = out[resources.key];
  const innerRule = isRecord(inner) ? ruleFor(inner[resources.key]) : undefined;
  if (innerRule) {
    for (const partial of resources.partials ?? []) {
      let copy = out[partial];
      if (!isRecord(copy)) continue;
      for (const path of [...(innerRule.paths ?? []), ...(innerRule.withheld ?? [])]) copy = applyPath(copy, path);
      out = { ...out, [partial]: copy };
    }
  }
  const rule = ruleFor(out[resources.key]);
  if (!rule) return out;
  for (const path of rule.paths ?? []) out = applyPath(out, path) as JsonRecord;
  if (rule.guest && !guestOnly(out, rule.guest)) {
    for (const path of rule.withheld ?? []) out = applyPath(out, path) as JsonRecord;
  } else if (rule.verbatim?.length) {
    verbatim.set(out, new Set(rule.verbatim));
  }
  return out;
}

interface Exemptions {
  keep: string[][];
  verbatim: WeakMap<object, Set<string>>;
  fields: Readonly<Record<string, FieldReview>>;
  scopeMaps: readonly string[];
}

/**
 * The defense-in-depth pass over any body: credential-named subtrees,
 * labelled and typed secret records, environment containers, deploy hook
 * URLs, destination headers, header/cookie/query rule values, route headers,
 * external route destinations reduced to their origin, and other URLs
 * sanitized. Reviewed `keep` paths and fields are exempt from the name rule
 * only; a resource rule's reviewed payer-facing URLs come back verbatim.
 */
function heuristic(value: unknown, exempt: Exemptions): unknown {
  const walk = (current: unknown, trail: string[], parent: string, depth: number): unknown => {
    if (depth > MAX_DEPTH) return REDACTED;
    if (typeof current === "string") return URL_SHAPE.test(current) ? sanitizeUrl(current) : current;
    if (Array.isArray(current)) return current.map((item) => walk(item, trail, parent, depth + 1));
    if (!isRecord(current)) return current;
    const labelled =
      credentialLabelled(current) || (typeof current["type"] === "string" && /secret/i.test(current["type"]));
    const destination = parent === "delivery" || "endpoint" in current || "deliveryFormat" in current;
    const out: JsonRecord = {};
    const verbatim = exempt.verbatim.get(current);
    for (const [key, item] of Object.entries(current)) {
      const path = [...trail, key];
      const normalized = normalizedName(key);
      const review = Object.hasOwn(exempt.fields, key) ? exempt.fields[key] : undefined;
      if (review?.verdict === "redact") {
        out[key] = withheld(item);
      } else if (labelled && LABELLED_VALUE_FIELDS.includes(key)) {
        out[key] = withheld(item);
      } else if (
        exempt.scopeMaps.includes(parent) &&
        Array.isArray(item) &&
        item.every((entry) => typeof entry === "string")
      ) {
        // Permission scopes: action names under a resource name, never secrets.
        out[key] = item;
      } else if (review?.verdict !== "keep" && !matches(exempt.keep, path) && containsCredential(normalized)) {
        // Both former rules apply: a value either would have removed is removed.
        out[key] = withheld(item);
      } else if (review?.verdict !== "keep" && !matches(exempt.keep, path) && CREDENTIAL_SUFFIX.test(normalized)) {
        out[key] = scrubStrings(item);
      } else if (ENV_CONTAINERS.includes(normalized)) {
        // Values go structurally; the rest of the container is still walked.
        out[key] = walk(scrubEnv(item, depth + 1), path, normalized, depth + 1);
      } else if (parent === "deployhooks" && key === "url") {
        out[key] = withheld(item);
      } else if (key === "headers" && destination && isRecord(item)) {
        out[key] = Object.fromEntries(Object.keys(item).map((header) => [header, REDACTED]));
      } else if (HEADER_RULE_VALUES.includes(key) && headerLike(current)) {
        // Any header, cookie, or query rule matches or sets this value,
        // wherever the rule sits and whatever its key's form.
        out[key] = withheld(item);
      } else if (key === "headers" && routeLike(current)) {
        out[key] = headerValues(item);
      } else if (DESTINATION_KEYS.includes(key) && typeof item === "string" && URL_SHAPE.test(item)) {
        // An external destination can carry its secret in the path; relative paths stay.
        out[key] = originOnly(item);
      } else if (typeof item === "string" && verbatim?.has(key)) {
        out[key] = item;
      } else {
        out[key] = walk(item, path, normalized, depth + 1);
      }
    }
    return out;
  };
  return walk(value, [], "", 0);
}

/** Whether a request field submits a credential or a stored secret. */
function credentialInput(name: string): boolean {
  return credentialName(name) || INPUT_CONTAINERS.test(normalizedName(name));
}

/** Whether a request-side schema names a credential input, to a fixed depth. */
function acceptsCredential(schema: JsonSchema | undefined, depth: number): boolean {
  if (depth > 4 || typeof schema !== "object" || schema === null) return false;
  const node = schema as { properties?: Record<string, JsonSchema>; items?: JsonSchema; anyOf?: JsonSchema[] };
  return (
    Object.entries(node.properties ?? {}).some(
      ([name, child]) => credentialInput(name) || acceptsCredential(child, depth + 1),
    ) ||
    acceptsCredential(node.items, depth + 1) ||
    (node.anyOf ?? []).some((branch) => acceptsCredential(branch, depth + 1))
  );
}

/** What a vendor's tools ask of its reviewed table. */
export interface ValueSafety {
  readonly table: ValueSafetyTable;
  /** The reviewed verdict for an operation, if it was flagged. */
  verdict(method: string, template: string): ValueSafetyVerdict | undefined;
  /** The refusal for a `refuse` verdict, before anything is sent. */
  refusal(method: string, template: string): string | undefined;
  /** One success body made value-safe: reviewed paths, environment bodies, resource rules, then the heuristic. */
  redact(data: unknown, method: string, template: string): unknown;
  /**
   * Whether a failure's vendor text is withheld: any reviewed operation
   * unless its verdict says `errors: "vendor"`, or an unreviewed one whose
   * request accepts a credential-named field (an error may echo what was
   * submitted). Codes and statuses still route.
   */
  withholdsErrors(op: Operation): boolean;
}

/** A vendor's value-safety mechanism over its reviewed table and pinned index. */
export function valueSafety(table: ValueSafetyTable, index: () => OperationIndex): ValueSafety {
  const fields = table.fields ?? {};
  const scopeMaps = table.scopeMaps ?? [];
  const inputs = new Map<number, boolean>();
  const verdict = (method: string, template: string) => {
    const key = `${method} ${template}`;
    return Object.hasOwn(table.operations, key) ? table.operations[key] : undefined;
  };
  return {
    table,
    verdict,
    refusal(method, template) {
      const reviewed = verdict(method, template);
      return reviewed?.verdict === "refuse" ? `Connecta refuses ${method} ${template}. ${reviewed.reason}` : undefined;
    },
    redact(data, method, template) {
      const reviewed = verdict(method, template);
      let out = data;
      if (reviewed?.verdict === "redact") for (const path of reviewed.paths) out = applyPath(out, path);
      if (table.envBodies?.test(template)) out = scrubValues(out, 0);
      const verbatim = new WeakMap<object, Set<string>>();
      if (table.resources) out = resourcePass(out, table.resources, verbatim, 0);
      const keep = reviewed && reviewed.verdict !== "refuse" ? (reviewed.keep ?? []) : [];
      return heuristic(out, { keep: keep.map(trailOf), verbatim, fields, scopeMaps });
    },
    withholdsErrors(op) {
      const reviewed = verdict(op.method, op.path);
      if (reviewed !== undefined) return reviewed.verdict === "refuse" || reviewed.errors !== "vendor";
      if (op.row < 0) return false;
      let known = inputs.get(op.row);
      if (known === undefined) {
        const contract = index().contract(op);
        known =
          contract.parameters.some((parameter) => parameter.in === "query" && credentialInput(parameter.name)) ||
          (contract.body !== undefined &&
            (typeof contract.body.schema !== "object" || acceptsCredential(contract.body.schema, 0)));
        inputs.set(op.row, known);
      }
      return known;
    },
  };
}
