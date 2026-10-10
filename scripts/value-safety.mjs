// Maintainer tooling: list the operations of an OpenAPI document whose
// responses may carry a credential or a stored secret value, so a provider's
// reviewed value-safety table can be checked for completeness offline.
//
// The bar (decision 0005, "Value safety"): no tool response returns a
// credential or a stored secret value unless a reviewed named tool exists to
// return it. Field-by-field redaction over a whole API cannot converge, so
// every REST vendor reviews each operation this module flags with a verdict —
// `refuse`, `redact` (reviewed field paths), or `safe` — in its
// `value-safety.ts`, and the shared harness
// (`src/providers/_shared/rest/value-safety-harness.ts`) fails when a flagged
// operation has none, or a flagged field is neither redacted nor kept.
//
// One detector serves every vendor. It is the union of the two that preceded
// it (Cloudflare's generator `responseSecrets` and Vercel's candidates file),
// and deliberately over-inclusive; the review decides.
//
// `generate-openapi.mjs` writes the result to `value-safety.candidates.json`
// beside the index when the source record sets `"valueSafety"`, stamped with
// the pinned digest and this format, so a moved pin or a tightened rule
// forces a fresh review.

const VERBS = ["get", "post", "put", "patch", "delete", "head"];
/**
 * Bump when the detection changes, so committed candidate files read as
 * stale. 4: one detector for every vendor (the union of Cloudflare's
 * suffix vocabulary and Vercel's containment vocabulary, both description
 * rules, `x-sensitive`, and both operation vocabularies).
 */
export const VALUE_SAFETY_FORMAT = 4;

/** Credential vocabulary over normalized names (lowercase, separators removed), matched anywhere in the name. */
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

/**
 * Credential vocabulary matched as the end of a normalized name: plurals,
 * pre-shared and stream keys, bearer URLs, and JWKS. The runtime heuristic
 * (`src/providers/_shared/rest/value-safety.ts`) uses the same expression.
 */
export const CREDENTIAL_SUFFIX =
  /(tokens?|secrets?|passwords?|passphrases?|privatekeys?|apikeys?|authkey|authorization|cookies?|signature|jwts?|credentials?|psks?|streamkeys?|uploadurl|signedurl|jwks?|verifier|devicecode|bypass)$/;

/**
 * Containers that hold secrets (key lists, headers, environment variables,
 * bindings): flagged for review, and at runtime they mark a request that
 * submits secrets, but they are not redacted by name.
 */
export const CONTAINER_SUFFIX = /(keys|headers?|envvars|environmentvariables|bindings)$/;

/**
 * Metadata that names a credential without carrying it: identifiers,
 * prefixes and suffixes, last-four digits, counts, types, timestamps, scopes,
 * and booleans about one. Matched as a suffix of the normalized name; the
 * suffix vocabulary above is anchored at the end, so it needs no exemption.
 */
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

/** Exact normalized names that hold metadata or counts despite a credential word. */
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

/** Names the description rules treat as metadata even when the description mentions a credential. */
const DESCRIBED_METADATA =
  /(id|ids|uid|name|names|at|on|created|modified|time|status|type|types|scope|scopes|comment|count|email|preview|prefix|hint|version|enabled|expires|expiration|url|urls|domain|domains|location|mode|via|provisionertype|lastfour|last4)$/;

const ENV_CONTAINERS = ["env", "envs", "envvar", "envvars", "newenvvar", "oldenvvar", "sharedenvvar", "sharedenvvars"];
const URL_NAMES = ["url", "uri", "endpoint", "href"];
/** Operation paths, ids, and summaries that name a secret family. */
const OPERATION_WORDS = [
  /token|secret|credential|password|bypass|authoriz|auth-?code|signing|sign\b|\bkeys?\b|api-keys|\benv\b|\/env\b|deploy-?hook|drain|webhook|transfer|claim|invit/i,
  /passphrase|private[-_ ]?key|\bpsk\b|psk_|jwt|signed[-_ ]?url|upload[-_ ]?url|direct[-_ ]upload|api[-_ ]?keys?\b|client[-_ ]secret|tsig|turn[-_ ]keys?|presign|kubeconfig|rotate/i,
];
/** A response field whose description says it carries a credential, whatever its name. */
const CREDENTIAL_DESCRIPTIONS = [
  /\b(?:secret|tokens?|passwords?|credentials?|api[- ]?keys?|private[- ]keys?|bearer|claim|transfer code|authori[sz]ation code|access code|invite code|invitation (?:code|link)|used to join|can be used to join|one-time|verifier|signing key|grants? access)\b/i,
  /\b(secrets?|passwords?|passphrase|private keys?|api keys?|api tokens?|access keys?|bearer|client secrets?|credentials?|signing keys?|auth(entication|orization) (tokens?|headers?)|environment variables?)\b/i,
];
/**
 * An operation description that says the response hands back something a
 * holder can use: "Returns a `code` that remains valid for 24 hours".
 */
const ISSUING_DESCRIPTION =
  /\b(?:returns?|generates?|creates?|issues?|mints?)\b[^.]{0,80}?\b(?:token|code|secret|key|password|credential|link)\b[^.]{0,80}?\b(?:valid|accept|claim|use[sd]? to|grants?|expires?)\b/i;

export function normalizedName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Whether a name is metadata (ids, prefixes, counts, timestamps, …) by its suffix or the reviewed list. */
function metadataName(name) {
  const normalized = normalizedName(name);
  return (
    METADATA_NAMES.includes(normalized) ||
    METADATA_SUFFIXES.some((suffix) => normalized.endsWith(suffix) && normalized !== suffix)
  );
}

/** A credential word anywhere in a name that is not metadata (the containment rule). */
function containsCredential(name) {
  const normalized = normalizedName(name);
  return CREDENTIAL_WORDS.some((word) => normalized.includes(word)) && !metadataName(name);
}

/**
 * Whether a key names a credential, as the runtime heuristic decides: a
 * credential suffix, or a credential word anywhere in a name that is not
 * metadata.
 */
export function credentialName(name) {
  return CREDENTIAL_SUFFIX.test(normalizedName(name)) || containsCredential(name);
}

/**
 * Vercel's former rule: a credential word in a name that is not metadata, or
 * a property description that says the value carries a credential.
 */
function containmentRule(name, description) {
  return containsCredential(name) || (CREDENTIAL_DESCRIPTIONS[0].test(description) && !metadataName(name));
}

/**
 * Cloudflare's former rule, on fields that can carry a value back (not
 * write-only, not a boolean or number): a credential or container suffix,
 * `x-sensitive`, or a schema description that names a credential.
 */
function suffixRule(name, description, sensitive) {
  const normalized = normalizedName(name);
  return (
    CREDENTIAL_SUFFIX.test(normalized) ||
    CONTAINER_SUFFIX.test(normalized) ||
    sensitive ||
    (CREDENTIAL_DESCRIPTIONS[1].test(description) && !DESCRIBED_METADATA.test(normalized))
  );
}

function pointer(document, ref) {
  let node = document;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (node === null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

function resolved(document, raw) {
  let node = raw;
  const seen = new Set();
  while (node && typeof node === "object" && typeof node.$ref === "string") {
    if (seen.has(node.$ref)) return undefined;
    seen.add(node.$ref);
    node = pointer(document, node.$ref);
  }
  return node && typeof node === "object" ? node : undefined;
}

/**
 * An id-or-object union (`anyOf: [string, $ref]`): Stripe answers the id
 * unless the caller expands it, and the expanded object is its own
 * operation's candidate.
 */
function expansion(document, node) {
  const union = Array.isArray(node?.anyOf) ? node.anyOf : [];
  return (
    union.some((branch) => resolved(document, branch)?.type === "string") &&
    union.some((branch) => typeof branch?.$ref === "string")
  );
}

/**
 * Field paths (dot syntax, `[]` for items, `{}` for map values) a response
 * schema flags. With `expansions: false`, the object branch of an
 * id-or-object union is not walked.
 */
function flaggedFields(document, schema, options = {}) {
  const fields = new Set();
  const visit = (raw, path, depth, seen, parent) => {
    if (depth > 12 || !raw || typeof raw !== "object") return;
    let node = raw;
    let refs = seen;
    while (node && typeof node === "object" && typeof node.$ref === "string") {
      if (refs.has(node.$ref)) return;
      refs = new Set([...refs, node.$ref]);
      node = pointer(document, node.$ref);
    }
    if (!node || typeof node !== "object") return;
    const unexpanded = options.expansions === false && expansion(document, node);
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      for (const branch of Array.isArray(node[key]) ? node[key] : []) {
        if (unexpanded && typeof branch?.$ref === "string") continue;
        visit(branch, path, depth + 1, refs, parent);
      }
    }
    const properties = node.properties && typeof node.properties === "object" ? node.properties : {};
    const keyed = "key" in properties;
    for (const [name, child] of Object.entries(properties)) {
      const at = path ? `${path}.${name}` : name;
      const normalized = normalizedName(name);
      const target = resolved(document, child) ?? {};
      // The containment rule read the property's own description; the suffix
      // rule read the resolved schema's. Each keeps its own.
      const description = typeof child?.description === "string" ? child.description : "";
      const carries = target.writeOnly !== true && !["boolean", "integer", "number"].includes(target.type);
      if (
        containmentRule(name, description) ||
        (carries &&
          suffixRule(
            name,
            typeof target.description === "string" ? target.description : "",
            child?.["x-sensitive"] === true || target["x-sensitive"] === true,
          )) ||
        (keyed && ["value", "vsmvalue", "legacyvalue", "decryptedvalue"].includes(normalized)) ||
        ENV_CONTAINERS.includes(normalized) ||
        (URL_NAMES.includes(normalized) &&
          (/secret|token|credential|auth/i.test(description) || ["deployhooks", "delivery"].includes(parent)))
      ) {
        fields.add(at);
      }
      visit(child, at, depth + 1, refs, normalized);
    }
    if (node.items) visit(node.items, `${path}[]`, depth + 1, refs, parent);
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      visit(node.additionalProperties, `${path}{}`, depth + 1, refs, parent);
    }
  };
  visit(schema, "", 0, new Set(), "");
  return [...fields].sort();
}

/**
 * Every non-deprecated operation whose 2xx response schema has a flagged
 * field (by name, description, or `x-sensitive`), whose path, operationId, or
 * summary names a secret family, or whose description says it issues
 * something a holder can use (a code, token, key, or link that is valid or
 * accepted): `{ "METHOD /path": { fields: [...], named: boolean } }`, sorted.
 */
export function valueSafetyCandidates(document, options = {}) {
  // A vendor's own secret families whose responses carry free-form values
  // (Vercel's Global Config items) are named in its source record.
  const vendorWords = typeof options.operationWords === "string" ? new RegExp(options.operationWords, "i") : undefined;
  const out = {};
  for (const path of Object.keys(document.paths ?? {}).sort()) {
    const item = resolved(document, document.paths[path]);
    for (const verb of VERBS) {
      const operation = item?.[verb];
      if (!operation || typeof operation !== "object" || operation.deprecated === true) continue;
      const fields = new Set();
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (!status.startsWith("2")) continue;
        for (const media of Object.values(resolved(document, response)?.content ?? {})) {
          for (const field of flaggedFields(document, media?.schema, options)) fields.add(field);
        }
      }
      const text = `${path} ${operation.operationId ?? ""} ${operation.summary ?? ""}`;
      const description = typeof operation.description === "string" ? operation.description : "";
      const named =
        OPERATION_WORDS.some((pattern) => pattern.test(text)) ||
        ISSUING_DESCRIPTION.test(description) ||
        (vendorWords?.test(text) ?? false);
      if (fields.size > 0 || named) out[`${verb.toUpperCase()} ${path}`] = { fields: [...fields].sort(), named };
    }
  }
  return out;
}

/** The committed candidates file: the pin it was derived from, and the flagged operations. */
export function renderValueSafety(document, source) {
  const options = typeof source.options?.valueSafety === "object" ? source.options.valueSafety : {};
  return `${JSON.stringify(
    {
      format: VALUE_SAFETY_FORMAT,
      digest: source.digest,
      options,
      candidates: valueSafetyCandidates(document, options),
    },
    null,
    2,
  )}\n`;
}
