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
// Residual risk: a secret a person typed into a free-text
// name, description, log line, or identifier is out of scope.
//
// Sent-secret redaction runs first, in the provider kit's parse pass, so a
// rule that decides on a value can find the placeholder where the vendor
// wrote what the rule matches. Every such decision input fails closed
// (#703): an altered type discriminator applies every resource rule; an
// altered label or type makes a secret record or a header rule; an altered
// URL scheme or parameter name withholds the whole URL or its value; an
// altered key withholds its value; a placeholder that may stand for a
// credential's public prefix withholds the remainder after it.
//
// The key-name rules combine Cloudflare's and Vercel's former engines.
// URL policy and exemptions are reviewed per vendor in its table (`keep`,
// `fields`, `scopeMaps`, `envBodies`, `embeddedUrls`).
import { ConnectorCallError } from "../../../errors.js";
import {
  bareReferenceEnd,
  characterReferenceEnd,
  REDACTED,
  redactionAltered,
  splitRemainder,
} from "../../../redaction-marker.js";
import type { JsonSchema } from "../../../types.js";
import type { Operation, OperationIndex } from "./operation-index.js";

/** What a removed secret reads as: the placeholder sent-secret redaction writes too. */
export { REDACTED };

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
/** What makes a string text rather than one whole URL: whitespace, quotes, escapes, entities, Markdown. */
const TEXT = /[\s<>"'`\\]|&(?:#|[a-z]+;)|\]\(/i;
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
  /** Global signing names plus generic credential names only on these reviewed response paths. */
  readonly embeddedUrls?: {
    readonly operations?: Readonly<Record<string, readonly string[]>>;
    /** Discriminated resources, wherever lists, expansions, or events embed them. */
    readonly resources?: {
      readonly key: string;
      readonly partials?: readonly string[];
      readonly paths: Readonly<Record<string, readonly string[]>>;
    };
  };
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
  /**
   * Review evidence, never read at runtime: table paths the pinned response
   * schema lacks (a shared verdict, or a field the schema leaves undeclared),
   * which still apply. `providers:spec` checks every other path resolves.
   */
  readonly absent?: {
    readonly reason: string;
    readonly operations?: Readonly<Record<string, readonly string[]>>;
    readonly resources?: Readonly<Record<string, readonly string[]>>;
  };
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

/** A rule's test over one decision input; an input redaction altered passes it (#703). */
function decides(input: unknown, test: (input: string) => boolean): boolean {
  return typeof input === "string" && (redactionAltered(input) || test(input));
}

/** Value safety's own `@keys` placeholders, which no redaction of a vendor's key wrote. */
const PLACEHOLDER_KEYS = new WeakSet<object>();

/**
 * Whether redaction altered one of a record's keys, so no key-based decision
 * about it can be read (#703). Parsed JSON keeps its keys; text the kit
 * redacted whole and a result hook parsed after it (NDJSON, log streams) can
 * carry the placeholder in one.
 */
function keysAltered(value: JsonRecord): boolean {
  return !PLACEHOLDER_KEYS.has(value) && Object.keys(value).some(redactionAltered);
}

/** What may come before a URL's first placeholder when redaction took part of its scheme or authority. */
const SCHEME_PREFIX = /^(?:[a-z][a-z0-9+.-]*(?::\/{0,2})?)?$/i;

/**
 * Whether redaction altered the scheme a whole-string URL decision reads
 * (#703): the text is no longer URL-shaped, everything before its first
 * placeholder could begin a URL, and more than placeholders follows it. A
 * URL a vendor sends holds no whitespace.
 */
function alteredScheme(text: string): boolean {
  if (!redactionAltered(text) || URL_SHAPE.test(text) || /\s/.test(text)) return false;
  const at = text.indexOf(REDACTED);
  return SCHEME_PREFIX.test(text.slice(0, at)) && text.slice(at).replaceAll(REDACTED, "") !== "";
}

/**
 * Every place a parameter name can sit in a URL's path, query, or fragment:
 * each run before an `=` since the last `/`, `?`, `&`, `#`, `;`, or `=`. A
 * name redaction altered, or a separator it took, leaves the placeholder in
 * one of them.
 */
function parameterNames(text: string): string[] {
  return text.split(/[/?&#;]/).flatMap((part) => part.split("=").slice(0, -1));
}

/** Whether a fragment carries a placeholder other than the one value safety writes for a withheld fragment. */
function alteredFragment(fragment: string): boolean {
  return redactionAltered(fragment) && fragment !== REDACTED;
}

/** A URL without userinfo, credential query parameters, or a credential-looking fragment; anything unparseable is withheld. */
function sanitizeUrl(value: string, credentials = true): string {
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
  for (const name of credentials ? Array.from(url.searchParams.keys()) : []) {
    if (URL_PARAM_CONTAINS.test(name) || URL_PARAM_SUFFIX.test(name.toLowerCase().replace(/[_-]/g, ""))) {
      url.searchParams.set(name, REDACTED);
      changed = true;
    }
  }
  if (credentials && url.hash && /token|secret|key|code|auth/i.test(url.hash)) {
    url.hash = "";
    changed = true;
  }
  // An ordinary URL comes back exactly as the vendor sent it.
  return changed ? url.toString() : value;
}

// Embedded URLs in reviewed REST text lose credential-bearing queries and
// fragments. AWS and Google signing parameters are withheld globally. The
// destination scanner also drives generic write admission for copied placeholders.

/** Signing parameters that are a credential in any URL, with their `=` plain or encoded. */
const SIGNING_PARAM =
  /x-(?:amz|goog)-(?:signature|credential|security-token)(?:=|%(?:25)*3d|&(?:amp(?:;|(?=#))|#0*38;?|#x0*26;?)*(?:#0*61;?|#x0*3d;?|equals;?)|\\u003d)/gi;
/**
 * One encoded character at the start of link text: a percent escape, an HTML
 * character reference, a `\u` or `\x` escape, or a Markdown backslash escape.
 */
const LEADING_ESCAPE =
  /^(?:%([0-9a-f]{2})|&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|quot|apos|lt|gt|quest|num|semi|equals|sol|percnt|bsol));?|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\)/i;
/** One encoded character just before a host: the same escapes, read backwards over a few characters. */
const TRAILING_ESCAPE =
  /(?:%(?:25){0,4}([0-9a-f]{2})|&(?:#0{0,6}(\d{1,7})|#x0{0,6}([0-9a-f]{1,6})|([a-z]{2,6}));?|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\)$/i;
/** Every escape in link text, decoded together; an unknown entity name stays as written. */
const ESCAPES =
  /%([0-9a-f]{2})|&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));?|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\(?=[^a-z0-9])/gi;
/** One slash however it is spelled, read forwards. */
const SLASH = /\/|\\\/|%(?:25){0,4}2f|&#0{0,6}47;?|&#x0{0,6}2f;?|&sol;?|\\u002f|\\x2f/iy;
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  colon: ":",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  quest: "?",
  num: "#",
  semi: ";",
  equals: "=",
  sol: "/",
  percnt: "%",
  bsol: "\\",
  lbrack: "[",
  rbrack: "]",
  lsqb: "[",
  rsqb: "]",
  period: ".",
};
/** The longest scheme read back from its `:`. */
const MAX_SCHEME = 32;
const SCHEME_CHAR = /[a-z0-9+.-]/i;
/** What may open a scheme-less `//host`: whitespace or punctuation that opens a link, value, or attribute. */
const OPENS_LINK = /[\s"'`(<[{=,;|]/;
/** Punctuation that may close the syntax around a link; it carries no secret, so it comes back. */
const TRAILING = /[)\]}.,;:!*_~`\\]/;

/** Code points past Unicode's range decode to nothing rather than throw. */
function codePoint(value: number): string {
  return value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

/** The character an escape's groups spell: percent, decimal, hex, name, `\u`, `\x`; a bare backslash spells nothing. */
function unescaped(groups: ReadonlyArray<string | undefined>): string | undefined {
  const [percent, decimal, hex, name, unicode, byte] = groups;
  if (percent !== undefined) return String.fromCharCode(Number.parseInt(percent, 16));
  if (decimal !== undefined) return codePoint(Number(decimal));
  if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
  if (name !== undefined) return NAMED[name.toLowerCase()];
  if (unicode !== undefined || byte !== undefined) return String.fromCharCode(Number.parseInt((unicode ?? byte)!, 16));
  return "";
}

/**
 * Whether link text opens its query or fragment here once decoded as a
 * browser, a Markdown renderer, or a JSON parser would: `%3F`, `%253F`,
 * `&#63;`, `&amp;#35;`, `?`. Only the leading character matters, so
 * each round decodes one escape there: constant work.
 */
function opener(text: string, at: number): "?" | "#" | undefined {
  let current = text.slice(at, at + 32);
  for (let round = 0; round < 4; round++) {
    if (current[0] === "?" || current[0] === "#") return current[0];
    const escape = LEADING_ESCAPE.exec(current);
    if (!escape) return undefined;
    current = (unescaped(escape.slice(1)) ?? "") + current.slice(escape[0].length);
  }
  return current[0] === "?" || current[0] === "#" ? current[0] : undefined;
}

/** The character ending just before `at`, decoded if it is escaped, and how many characters spell it. */
function charBefore(text: string, at: number): { char: string; length: number } {
  const escape = TRAILING_ESCAPE.exec(text.slice(Math.max(0, at - 16), at));
  const char = escape ? unescaped(escape.slice(1)) : undefined;
  if (escape && char) return { char, length: escape[0].length };
  // A JSON-escaped slash, `\/`, is one slash.
  if (text[at - 1] === "/" && text[at - 2] === "\\") return { char: "/", length: 2 };
  return { char: text[at - 1]!, length: 1 };
}

/**
 * Where the link whose authority opens at `at` starts, or `-1` when no
 * authority opens there: `//` however spelled, after a scheme's `:`
 * (`https:`, `https%3A`), the text's start, or what opens a scheme-less
 * link (`src=//`, ` //`). A `//` after anything else (`example.com//`) is
 * part of a path.
 */
function authorityAt(text: string, at: number): number {
  if (at === 0) return -1;
  const second = charBefore(text, at);
  const between = at - second.length;
  if (second.char !== "/" || between <= 0) return -1;
  const first = charBefore(text, between);
  const slashes = between - first.length;
  if (first.char !== "/" || slashes < 0) return -1;
  if (slashes === 0) return 0;
  const before = charBefore(text, slashes);
  if (before.char !== ":") return OPENS_LINK.test(before.char) ? slashes : -1;
  const colon = slashes - before.length;
  let start = colon;
  while (start > 0 && colon - start < MAX_SCHEME && SCHEME_CHAR.test(text[start - 1]!)) start--;
  return start < colon && (start === 0 || OPENS_LINK.test(text[start - 1]!)) ? start : -1;
}

/** Whether the `#` at `at` belongs to a numeric character reference (`&#38;`) rather than opening a fragment. */
function reference(text: string, at: number): boolean {
  return text.charCodeAt(at - 1) === 0x26 && /[0-9x]/i.test(text[at + 1] ?? "");
}

/** Whitespace, a quote, or an angle bracket: where a link in text ends, read fail-closed. */
function endsLink(code: number, char: string): boolean {
  if (code <= 0x20 || code === 0x22 || code === 0x27 || code === 0x3c || code === 0x3e) return true;
  return code > 0x7f && /\s/.test(char);
}

/** Where a signing parameter's value ends: its link's end, or the next parameter or closing bracket. */
function endsValue(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  if (endsLink(code, text[at]!)) return true;
  if (code === 0x26 || code === 0x23 || code === 0x29 || code === 0x5d || code === 0x60) return true;
  // `\/` is a JSON-escaped slash inside the value; any other backslash escapes what follows it.
  return code === 0x5c && text.charCodeAt(at + 1) !== 0x2f;
}

/**
 * Where a word at `start` holds a placeholder in place of a link's scheme
 * and host (`[redacted]/pkg?token=…`, `https:[redacted]…`), or `-1`:
 * redaction took the authority that makes text a link (#703). A Markdown
 * label (`[redacted](…)`) is not one; its destination is read as a link.
 */
function markerLed(text: string, start: number): number {
  let at = start;
  while (at < text.length && at - start <= MAX_SCHEME + 3 && /[a-z0-9+.:/-]/i.test(text[at]!)) at++;
  return text.startsWith(REDACTED, at) &&
    text[at + REDACTED.length] !== "(" &&
    SCHEME_PREFIX.test(text.slice(start, at))
    ? at
    : -1;
}

/** The authority immediately after a destination's scheme and slashes, however escaped. */
function destinationHost(text: string, start: number): number | undefined {
  // A scheme and three escaped characters (colon and slashes), each bounded
  // as in charBefore. Never search a destination's path or query for another.
  for (let at = start; at < Math.min(text.length, start + MAX_SCHEME + 48); at++) {
    SLASH.lastIndex = at;
    if (!SLASH.test(text)) continue;
    const next = SLASH.lastIndex;
    SLASH.lastIndex = next;
    if (!SLASH.test(text)) return undefined;
    const host = SLASH.lastIndex;
    return authorityAt(text, host) === start ? host : undefined;
  }
  return undefined;
}

/** CommonMark permits spaces/tabs and at most one line ending before a destination. */
function markdownStart(text: string, at: number): number | undefined {
  let line = false;
  for (; at < text.length; at++) {
    const char = text[at];
    if (char === " " || char === "\t") continue;
    if (char !== "\r" && char !== "\n") return at;
    if (line) return undefined;
    line = true;
    if (char === "\r" && text[at + 1] === "\n") at++;
  }
  return at;
}

interface LinkSpan {
  cut: number;
  open: string;
  end: number;
}

interface Link extends LinkSpan {
  /** Where the link begins: its scheme, its `//`, or its Markdown destination. */
  start: number;
  /** Where its authority begins, or its destination when it has none. */
  host: number;
}

/**
 * Read a destination once. Admission ends at its actual CommonMark close,
 * counting balanced and escaped parentheses, before inspecting its query.
 */
function linkSpan(text: string, start: number, host: number, inline: boolean): LinkSpan {
  let depth = 0;
  let escaped = false;
  let cut = -1;
  let open = "?";
  let end = start;
  for (; end < text.length; end++) {
    const code = text.charCodeAt(end);
    if (endsLink(code, text[end]!)) break;
    if (inline) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x28) depth++;
      else if (code === 0x29 && depth-- === 0) break;
    }
    if (end < host || cut >= 0) continue;
    if (code === 0x3f || (code === 0x23 && !reference(text, end))) {
      cut = end;
      open = text[end]!;
    } else if (code === 0x25 || code === 0x26 || code === 0x5c) {
      const opens = opener(text, end);
      if (opens) {
        cut = end;
        open = opens;
      }
    }
  }
  return { cut, open, end };
}

/**
 * Visit each destination once, respecting its CommonMark close and encoded
 * delimiters. Redaction (`failClosed`) also reads a link whose scheme and
 * host redaction took (#703); admission never does.
 */
function* linkSpans(text: string, failClosed = false): Generator<Link> {
  const markers = failClosed && redactionAltered(text);
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    const marker = markers && (at === 0 || OPENS_LINK.test(text[at - 1]!)) ? markerLed(text, at) : -1;
    if (marker >= 0) {
      // A placeholder opening a word stands where a link's scheme and host may have been.
      // Its run is read once, query or not, and the scan resumes after it.
      const host = marker + REDACTED.length;
      const span = linkSpan(text, host, host, false);
      const start = at;
      at = Math.max(at, span.end - 1);
      yield { ...span, start, host };
      continue;
    }
    if (char === "]" && text[at + 1] === "(") {
      const destination = markdownStart(text, at + 2);
      if (destination !== undefined) {
        const angle = text[destination] === "<";
        const start = destination + (angle ? 1 : 0);
        const host = destinationHost(text, start) ?? start;
        const span = linkSpan(text, start, host, !angle);
        at = Math.max(destination, span.end) - 1;
        yield { ...span, start, host };
        continue;
      }
    }
    if (char === "/" || char === "\\" || char === "%" || char === "&") {
      SLASH.lastIndex = at;
      if (SLASH.test(text)) {
        const next = SLASH.lastIndex;
        SLASH.lastIndex = next;
        if (SLASH.test(text)) {
          const authority = SLASH.lastIndex;
          const begin = authorityAt(text, authority);
          const span = linkSpan(text, authority, authority, false);
          const start = begin >= 0 ? begin : at;
          at = span.end - 1;
          yield { ...span, start, host: authority };
        }
      }
    }
  }
}

/** A credential-named parameter in a URL, rather than an assignment in prose. */
function credentialQuery(text: string): boolean {
  let decoded = decodeLinkText(text, false);
  // Decode the destination's enclosing percent layers only until its own
  // opener is visible. Encoded &/# inside a proxy parameter remain data,
  // rather than becoming parameters or a fragment of the outer URL.
  for (let round = 0; round < 4 && decoded[0] !== "?" && decoded[0] !== "#"; round++) {
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === decoded) break;
    decoded = next;
  }
  const fragment = decoded.indexOf("#");
  if (fragment >= 0) {
    const words = decodeLinkText(decoded.slice(fragment + 1));
    // A fragment redaction altered cannot be read (#703).
    if (/token|secret|key|code|auth/i.test(words) || alteredFragment(words)) return true;
  }
  const query = fragment < 0 ? decoded : decoded.slice(0, fragment);
  for (let at = query[0] === "?" ? 1 : 0; at < query.length;) {
    const next = query.indexOf("&", at);
    const end = next < 0 ? query.length : next;
    const pair = decodeLinkText(query.slice(at, end));
    const equals = pair.indexOf("=");
    at = end + 1;
    // A component redaction altered with no readable name (its name, or its `=`, taken) may be a
    // credential parameter's value, however encoded (#703).
    if (pair !== REDACTED && redactionAltered(equals < 0 ? pair : pair.slice(0, equals))) return true;
    if (equals < 0) continue;
    const name = pair.slice(0, equals);
    if (!URL_PARAM_CONTAINS.test(name) && !URL_PARAM_SUFFIX.test(normalizedName(name))) continue;
    if (pair.slice(equals + 1) !== REDACTED) return true;
  }
  return false;
}

/** Remove a link's entire query/fragment, keeping its surrounding syntax. */
function withholdLinkQueries(text: string): string {
  let out = "";
  let copied = 0;
  for (const { cut, open, end, start, host } of linkSpans(text, true)) {
    // A parameter name redaction altered cannot be read, so the whole link goes (#703).
    const whole = alteredLink(text.slice(host, end));
    if (!whole && (cut < 0 || !credentialQuery(text.slice(cut, end)))) continue;
    const from = Math.max(whole ? start : cut, copied);
    // A reference's final semicolon belongs to the withheld query, not the surrounding prose.
    // Search only this disjoint span, once, even when it ends in a long punctuation run.
    const ampersand = text.slice(from, end).lastIndexOf("&");
    const referenceEnd = ampersand < 0 ? -1 : characterReferenceEnd(text, from + ampersand);
    let keep = end;
    while (keep > from + 1 && TRAILING.test(text[keep - 1]!)) {
      // A signing pass may already have replaced the final parameter. Its
      // closing bracket belongs to the value, not the surrounding Markdown.
      if (keep === referenceEnd || text.endsWith(REDACTED, keep)) break;
      keep--;
    }
    // A query with nothing in it.
    if (keep <= from + 1) continue;
    out += `${text.slice(copied, from)}${whole ? "" : open}${REDACTED}`;
    copied = keep;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** Whether redaction altered a parameter name in a link's own path, query, or fragment (#703). */
function alteredLink(link: string): boolean {
  return redactionAltered(link) && parameterNames(decodeLinkText(link)).some(redactionAltered);
}

function withholdSigningParams(anchored: string): string {
  let out = "";
  let copied = 0;
  SIGNING_PARAM.lastIndex = 0;
  let signing = SIGNING_PARAM.exec(anchored);
  let altered = alteredParameter(anchored, 0);
  while (signing || altered >= 0) {
    const named = signing ? signing.index + signing[0].length : -1;
    const inferred = altered >= 0 && (named < 0 || altered < named);
    const start = inferred ? altered : named;
    // Skip an existing complete placeholder, but still remove any suffix.
    const already = anchored.startsWith(REDACTED, start);
    const end = valueEnd(anchored, already ? start + REDACTED.length : start, inferred);
    // Resume both scans after this value, as one scan would.
    SIGNING_PARAM.lastIndex = end;
    if (named >= 0 && named <= end) signing = SIGNING_PARAM.exec(anchored);
    if (altered >= 0 && altered <= end) altered = alteredParameter(anchored, end);
    if (end === start || (already && end === start + REDACTED.length)) continue;
    out += `${anchored.slice(copied, start)}${REDACTED}`;
    copied = end;
  }
  return copied === 0 ? anchored : out + anchored.slice(copied);
}

/** An `=`, plain or encoded, as a signing parameter's name ends with one. */
const EQUALS = /=|%(?:25)*3d|&(?:amp(?:;|(?=#))|#0*38;?|#x0*26;?)*(?:#0*61;?|#x0*3d;?|equals;?)|\\u003d/iy;
const EQUALS_BEFORE = /(?:=|%(?:25)*3d|&(?:amp(?:;|(?=#))|#0*38;?|#x0*26;?)*(?:#0*61;?|#x0*3d;?|equals;?)|\\u003d)$/i;
const NAME_CHAR = /[\w.~-]/;

/** Where a parameter's value ends, reading placeholders and character references whole (#703). */
function valueEnd(text: string, at: number, inferred: boolean): number {
  while (at < text.length) {
    const reference = Math.max(characterReferenceEnd(text, at, inferred), bareReferenceEnd(text, at, inferred));
    if (text.startsWith(REDACTED, at)) at += REDACTED.length;
    else if (reference > at) at = reference;
    else if (endsValue(text, at)) break;
    else at++;
  }
  return at;
}

/**
 * Where the next placeholder that may hide a signing parameter starts, at or
 * after `from`, or `-1` (#703). Redaction may have taken a signing name, its
 * `=`, and the start of its value, so a placeholder followed by any of a
 * value's base64 or base64url characters (`+`, `/`, `=`, `-`, `_` included)
 * or `%` escapes goes with them, however short. References count when they
 * spell credential data or an ampersand, including a short numeric prefix
 * when no semicolon ends the reference. One inside a name ending at an
 * encoded `=` (`&#61;`, `\u003d`) gives that value's start. A placeholder
 * right after an `=` with nothing readable after it is a withheld value.
 * Each placeholder is read once, resuming after its run.
 */
function alteredParameter(text: string, from: number): number {
  for (let at = text.indexOf(REDACTED, from); at >= 0;) {
    const tail = splitRemainder(text, at, endsValue);
    if (tail.readable) return at;
    let end = at;
    while (end < tail.end) {
      if (text.startsWith(REDACTED, end)) end += REDACTED.length;
      else if (NAME_CHAR.test(text[end]!)) end++;
      else break;
    }
    EQUALS.lastIndex = end;
    if (
      redactionAltered(text.slice(at, end)) &&
      !EQUALS_BEFORE.test(text.slice(Math.max(0, at - 64), at)) &&
      EQUALS.test(text)
    )
      return EQUALS.lastIndex;
    at = text.indexOf(REDACTED, Math.max(tail.end, at + REDACTED.length));
  }
  return -1;
}

/**
 * Reviewed REST text policy: only credential-bearing URL queries/fragments
 * change. Ordinary links, including external proxies, retain their bytes.
 * Literal AWS/Google signing names are withheld anywhere, as in #818.
 */
export function withholdEmbeddedUrls(text: string): string {
  return withholdSigningParams(withholdLinkQueries(text));
}

/** Apply the reviewed text policy to a selected value or vendor error body. */
export function withholdEmbeddedUrlsIn(value: unknown): unknown {
  return mapStrings(value, withholdEmbeddedUrls, 0);
}

function mapStrings(value: unknown, cleanText: (text: string) => string, depth: number): unknown {
  if (typeof value === "string") return cleanText(value);
  if (typeof value !== "object" || value === null) return value;
  // Deeper than any vendor's shape: withheld, as the heuristic does.
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const clean = mapStrings(item, cleanText, depth + 1);
      if (clean !== item) changed = true;
      return clean;
    });
    return changed ? items : value;
  }
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const clean = mapStrings(item, cleanText, depth + 1);
    if (clean !== item) changed = true;
    return [key, clean] as const;
  });
  return changed ? Object.fromEntries(entries) : value;
}

/**
 * Link text decoded as a browser, a Markdown renderer, or a JSON parser
 * would, through up to four layers of escaping (`%255B`, `&amp;#91;`). Each
 * round is one linear pass.
 */
function decodeLinkText(text: string, percent = true): string {
  for (let round = 0; round < 4; round++) {
    const next = text.replace(ESCAPES, (token, ...groups: Array<string | undefined>) =>
      !percent && groups[0] !== undefined ? token : token === "\\" ? "" : (unescaped(groups.slice(0, 6)) ?? token),
    );
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * Whether a request value carries a link whose query or
 * fragment holds the exact `[redacted]` placeholder, plain or encoded: a
 * withheld read copied into a write, which would store the placeholder.
 * Only the link's own destination is read: a Markdown link ends at its
 * closing `)`, so `[f](…?a=1)[redacted]` is ordinary text after it.
 * The word alone (`unredacted`) or the placeholder away from a file link is
 * a person's text. Every destination uses the same policy regardless of host.
 */
export function carriesWithheldLink(value: unknown): boolean {
  const pending: Array<{ value: unknown; leave?: boolean }> = [{ value }];
  const ancestors = new WeakSet<object>();
  const inspect = (text: string): boolean => {
    for (const { cut, end } of linkSpans(text)) {
      if (cut >= 0 && decodeLinkText(text.slice(cut, end)).includes(REDACTED)) return true;
    }
    return false;
  };
  // JSON structure is bounded by the admitted request's bytes. Visit every key
  // and value iteratively, without imposing a smaller node/depth limit. Reject
  // cycles from direct callers; repeated non-cyclic references remain valid.
  while (pending.length > 0) {
    const { value: item, leave } = pending.pop()!;
    if (typeof item === "string") {
      if (inspect(item)) return true;
    } else if (typeof item === "object" && item !== null) {
      if (leave) {
        ancestors.delete(item);
        continue;
      }
      if (ancestors.has(item)) {
        throw new ConnectorCallError("invalid_args", "Not sent: URL admission cannot inspect cyclic JSON.");
      }
      ancestors.add(item);
      pending.push({ value: item, leave: true });
      if (Array.isArray(item)) {
        for (const child of item) pending.push({ value: child });
      } else {
        for (const [key, child] of Object.entries(item)) {
          if (inspect(key)) return true;
          pending.push({ value: child });
        }
      }
    }
  }
  return false;
}

/** Refuse a withheld destination copied into customer data, before any dispatch. */
export function refuseWithheldLinks(value: unknown, title: string): void {
  if (!carriesWithheldLink(value)) return;
  throw new ConnectorCallError(
    "invalid_args",
    `This write carries a URL whose query or fragment Connecta withheld ([redacted]), so ${title} would store the placeholder. Do not write withheld URLs back; obtain the original link or omit the field.`,
  );
}

/** Upload admission inspects actual bytes, including base64-decoded files and multipart blobs. */
export async function refuseWithheldUpload(body: BodyInit, title: string): Promise<void> {
  if (body instanceof FormData) {
    for (const [name, part] of body) {
      refuseWithheldLinks(name, title);
      if (typeof part === "string") refuseWithheldLinks(part, title);
      else {
        refuseWithheldLinks(part.name, title);
        refuseWithheldLinks(await part.text(), title);
      }
    }
  } else if (body instanceof Blob) refuseWithheldLinks(await body.text(), title);
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    refuseWithheldLinks(new TextDecoder().decode(body), title);
  } else refuseWithheldLinks(body instanceof URLSearchParams ? body.toString() : body, title);
}

/** Only for documented JSON fields the vendor decodes as base64, never arbitrary strings. */
export async function refuseWithheldBase64(value: unknown, title: string, maxDecodedBytes?: number): Promise<void> {
  if (typeof value !== "string") {
    throw new ConnectorCallError("invalid_args", "Not sent: a base64 field must be a string.");
  }
  // One decode, bounded by this field's own encoded length (at most 3/4 as
  // many bytes), itself bounded by the host's request limit. Operation-specific
  // value limits are independent of response caps and raw-upload caps.
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new ConnectorCallError("invalid_args", "Not sent: a base64 field must be valid base64.");
  }
  if (maxDecodedBytes !== undefined && decoded.length > maxDecodedBytes) {
    throw new ConnectorCallError(
      "invalid_args",
      `Not sent: a base64 field must encode at most ${maxDecodedBytes} bytes.`,
    );
  }
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  await refuseWithheldUpload(bytes, title);
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

/**
 * Whether a record's label names a credential, so its value or args are one.
 * A label redaction altered, or keys that may hide one, does too (#703).
 */
function credentialLabelled(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const target = value["target"];
  return (
    keysAltered(value) ||
    (isRecord(target) && keysAltered(target)) ||
    labelsOf(value).some((label) => decides(label, credentialName))
  );
}

/** A record typed as a secret (`secret_text`); a type redaction altered may have been one (#703). */
function typedSecret(value: JsonRecord): boolean {
  return keysAltered(value) || decides(value["type"], (type) => /secret/i.test(type));
}

/** A list item typed as an environment variable; a type redaction altered may have been one (#703). */
function envTyped(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return keysAltered(value) || decides(String(value["type"]), (type) => /env/i.test(type));
}

/** A header, cookie, or query rule (`request.headers`, `header`, `cookie`, `query`, …); likewise (#703). */
function headerLike(value: unknown): boolean {
  return isRecord(value) && (keysAltered(value) || decides(value["type"], (type) => /header|cookie|query/i.test(type)));
}

/** A route-like object: its `headers` are set on requests or responses. */
function routeLike(value: JsonRecord): boolean {
  return keysAltered(value) || ["src", "source", "dest", "destination"].some((key) => key in value);
}

/** Every value of a headers map, or of a list of `{ key, value }` header pairs, withheld. */
function headerValues(value: unknown): unknown {
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).map((name) => [name, REDACTED]));
  if (Array.isArray(value)) {
    // A pair whose keys redaction altered may hold its value under any of them (#703).
    return value.map((item) =>
      !isRecord(item)
        ? item
        : keysAltered(item)
          ? Object.fromEntries(
              Object.entries(item).map(([key, entry]) => [
                key,
                key === "value" || redactionAltered(key) ? withheld(entry) : entry,
              ]),
            )
          : "value" in item
            ? { ...item, value: REDACTED }
            : item,
    );
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
function applyPath(body: unknown, raw: string, transform?: (value: unknown) => unknown): unknown {
  const { mode, segments } = parsePath(raw);
  const step = (current: unknown, index: number): unknown => {
    if (index === segments.length) {
      if (transform) return transform(current);
      if (current === undefined || current === null) return current;
      if (mode === "url") return typeof current === "string" ? sanitizeUrl(current) : REDACTED;
      if (mode === "origin") return originOnly(current);
      return REDACTED;
    }
    const segment = segments[index]!;
    if (segment === "[]" || segment === "[?env]" || segment === "[?credential]" || segment === "[?header]") {
      if (!Array.isArray(current)) return current;
      return current.map((item) => {
        if (segment === "[?env]" && !envTyped(item)) return item;
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
      const keyed = Object.fromEntries(
        Object.values(current).map((item, position) => [`${REDACTED} ${position + 1}`, item]),
      );
      PLACEHOLDER_KEYS.add(keyed);
      return keyed;
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
    // A `NAME=value` string, or one whose name and `=` redaction may have taken (#703).
    return value.map((item) =>
      typeof item === "string" && (item.includes("=") || redactionAltered(item)) ? REDACTED : scrubEnv(item, depth + 1),
    );
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

/** Every rule's paths and withheld fields: the rule for an object whose type redaction altered (#703). */
const ANY_RULE = new WeakMap<ResourceRules, ResourceRule>();
function anyRule(resources: ResourceRules): ResourceRule {
  let rule = ANY_RULE.get(resources);
  if (!rule) {
    const paths = Object.values(resources.rules).flatMap((each) => [...(each.paths ?? []), ...(each.withheld ?? [])]);
    rule = { reason: "A type redaction altered may be any reviewed resource.", paths: [...new Set(paths)] };
    ANY_RULE.set(resources, rule);
  }
  return rule;
}

/**
 * What a record's type discriminator selects. A type redaction altered, or
 * one an altered key may hide, selects every rule at once (#703).
 */
function typed<T>(record: JsonRecord, key: string, rules: Readonly<Record<string, T>>, any: () => T): T | undefined {
  const type = record[key];
  if (redactionAltered(type) || (type === undefined && keysAltered(record))) return any();
  return typeof type === "string" && Object.hasOwn(rules, type) ? rules[type] : undefined;
}

/** What the discriminator of the object an event carries (`data.object`) selects, for its partial copies. */
function typedInner<T>(
  record: JsonRecord,
  key: string,
  rules: Readonly<Record<string, T>>,
  any: () => T,
): T | undefined {
  const inner = record[key];
  if (isRecord(inner)) return typed(inner, key, rules, any);
  return inner === undefined && keysAltered(record) ? any() : undefined;
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
  const any = () => anyRule(resources);
  // An event's `previous_attributes` is a partial copy of `data.object`: every reviewed path applies to it.
  const innerRule = typedInner(value, resources.key, resources.rules, any);
  if (innerRule) {
    for (const partial of resources.partials ?? []) {
      let copy = out[partial];
      if (!isRecord(copy)) continue;
      for (const path of [...(innerRule.paths ?? []), ...(innerRule.withheld ?? [])]) copy = applyPath(copy, path);
      out = { ...out, [partial]: copy };
    }
  }
  const rule = typed(value, resources.key, resources.rules, any);
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
  reviewedUrls: boolean;
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
    if (typeof current === "string") {
      // Scan original escaped text before URL parsing. A string containing
      // HTML, Markdown or escapes is text, even when it has no whitespace.
      // Reviewed vendors already scanned signing names and selected text;
      // generic names in customer data must retain their original bytes.
      if (!exempt.reviewedUrls) return URL_SHAPE.test(current) ? sanitizeUrl(current) : current;
      // A placeholder's own brackets are not Markdown; a URL whose scheme redaction
      // altered may still carry userinfo, so it is withheld whole (#703).
      const altered = redactionAltered(current);
      if (TEXT.test(altered ? current.replaceAll(REDACTED, "") : current)) return current;
      if (altered && alteredScheme(current)) return REDACTED;
      return URL_SHAPE.test(current) ? sanitizeUrl(current, false) : current;
    }
    if (Array.isArray(current)) return current.map((item) => walk(item, trail, parent, depth + 1));
    if (!isRecord(current)) return current;
    const labelled = credentialLabelled(current) || typedSecret(current);
    const placeholders = PLACEHOLDER_KEYS.has(current);
    const destination =
      parent === "delivery" || "endpoint" in current || "deliveryFormat" in current || keysAltered(current);
    const out: JsonRecord = {};
    const verbatim = exempt.verbatim.get(current);
    for (const [key, item] of Object.entries(current)) {
      const path = [...trail, key];
      const normalized = normalizedName(key);
      const review = Object.hasOwn(exempt.fields, key) ? exempt.fields[key] : undefined;
      if (!placeholders && redactionAltered(key)) {
        // A key redaction altered may have named a credential (#703).
        out[key] = withheld(item);
      } else if (review?.verdict === "redact") {
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
      } else if (
        DESTINATION_KEYS.includes(key) &&
        typeof item === "string" &&
        (URL_SHAPE.test(item) || alteredScheme(item))
      ) {
        // An external destination can carry its secret in the path; relative paths stay.
        // One whose scheme redaction altered does not parse, so it is withheld (#703).
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
      if (table.embeddedUrls) {
        // Do this before any reviewed URL rule parses/serializes the text.
        out = mapStrings(out, withholdSigningParams, 0);
        for (const path of table.embeddedUrls.operations?.[`${method} ${template}`] ?? []) {
          out = applyPath(out, path, withholdEmbeddedUrlsIn);
        }
        const resources = table.embeddedUrls.resources;
        if (resources) {
          // A type redaction altered takes every resource's reviewed text paths (#703).
          const all = [...new Set(Object.values(resources.paths).flat())];
          const any = () => all;
          const scan = (value: unknown, depth: number): unknown => {
            if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
            if (Array.isArray(value)) return value.map((item) => scan(item, depth + 1));
            let clean: JsonRecord = Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, scan(item, depth + 1)]),
            );
            const innerPaths = typedInner(value as JsonRecord, resources.key, resources.paths, any);
            if (innerPaths) {
              for (const partial of resources.partials ?? []) {
                if (!Object.hasOwn(clean, partial)) continue;
                for (const path of innerPaths) clean[partial] = applyPath(clean[partial], path, withholdEmbeddedUrlsIn);
              }
            }
            for (const path of typed(value as JsonRecord, resources.key, resources.paths, any) ?? [])
              clean = applyPath(clean, path, withholdEmbeddedUrlsIn) as JsonRecord;
            return clean;
          };
          out = scan(out, 0);
        }
      }
      if (reviewed?.verdict === "redact") for (const path of reviewed.paths) out = applyPath(out, path);
      if (table.envBodies?.test(template)) out = scrubValues(out, 0);
      const verbatim = new WeakMap<object, Set<string>>();
      if (table.resources) out = resourcePass(out, table.resources, verbatim, 0);
      const keep = reviewed && reviewed.verdict !== "refuse" ? (reviewed.keep ?? []) : [];
      return heuristic(out, {
        keep: keep.map(trailOf),
        verbatim,
        fields,
        scopeMaps,
        reviewedUrls: table.embeddedUrls !== undefined,
      });
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
