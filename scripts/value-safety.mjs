// Maintainer tooling: list the operations of an OpenAPI document whose
// responses may carry a credential or a stored secret value, so a provider's
// reviewed value-safety table can be checked for completeness offline.
//
// The bar (decision 0005, "Value safety"): no tool response returns a
// credential or a stored secret value unless a reviewed named tool exists to
// return it. Field-by-field redaction over a whole API cannot converge, so a
// REST vendor reviews every operation this module flags with a verdict —
// `refuse`, `redact` (reviewed field paths), or `safe` — and a provider test
// fails when a flagged operation has none. The detection is deliberately
// over-inclusive; the review decides.
//
// `generate-openapi.mjs` writes the result to `value-safety.candidates.json`
// beside the index when the source record sets `"valueSafety": true`, stamped
// with the pinned digest so a moved pin forces a fresh review.

const VERBS = ["get", "post", "put", "patch", "delete", "head"];
/** Bump when the detection changes, so committed candidate files read as stale. */
export const VALUE_SAFETY_FORMAT = 3;

/** Credential vocabulary over normalized names (lowercase, separators removed). */
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
 * Metadata that names a credential without carrying it: identifiers,
 * prefixes and suffixes, last-four digits, counts, types, timestamps, scopes,
 * and booleans about one. Matched as a suffix of the normalized name.
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

const ENV_CONTAINERS = ["env", "envs", "envvar", "envvars", "newenvvar", "oldenvvar", "sharedenvvar", "sharedenvvars"];
const URL_NAMES = ["url", "uri", "endpoint", "href"];
const OPERATION_WORDS =
  /token|secret|credential|password|bypass|authoriz|auth-?code|signing|sign\b|\bkeys?\b|api-keys|\benv\b|\/env\b|deploy-?hook|drain|webhook|transfer|claim|invit/i;
/**
 * A response field whose description says it carries a credential, whatever
 * its name: a claim or transfer code, a bearer value, a key, a verifier.
 */
const CREDENTIAL_DESCRIPTION =
  /\b(?:secret|tokens?|passwords?|credentials?|api[- ]?keys?|private[- ]keys?|bearer|claim|transfer code|authori[sz]ation code|access code|invite code|invitation (?:code|link)|used to join|can be used to join|one-time|verifier|signing key|grants? access)\b/i;
/**
 * An operation description that says the response hands back something a
 * holder can use: "Returns a `code` that remains valid for 24 hours".
 */
const ISSUING_DESCRIPTION =
  /\b(?:returns?|generates?|creates?|issues?|mints?)\b[^.]{0,80}?\b(?:token|code|secret|key|password|credential|link)\b[^.]{0,80}?\b(?:valid|accept|claim|use[sd]? to|grants?|expires?)\b/i;

/** Whether a name is metadata (ids, prefixes, counts, timestamps, …) by its suffix or the reviewed list. */
function metadataName(name) {
  const normalized = normalizedName(name);
  return (
    METADATA_NAMES.includes(normalized) ||
    METADATA_SUFFIXES.some((suffix) => normalized.endsWith(suffix) && normalized !== suffix)
  );
}

export function normalizedName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Whether a property name is credential vocabulary rather than metadata about one. */
export function credentialName(name) {
  const normalized = normalizedName(name);
  if (!CREDENTIAL_WORDS.some((word) => normalized.includes(word))) return false;
  if (METADATA_NAMES.includes(normalized)) return false;
  return !METADATA_SUFFIXES.some((suffix) => normalized.endsWith(suffix) && normalized !== suffix);
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

/** Field paths (dot syntax, `[]` for items, `{}` for map values) a response schema flags. */
function flaggedFields(document, schema) {
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
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      for (const branch of Array.isArray(node[key]) ? node[key] : []) visit(branch, path, depth + 1, refs, parent);
    }
    const properties = node.properties && typeof node.properties === "object" ? node.properties : {};
    const keyed = "key" in properties;
    for (const [name, child] of Object.entries(properties)) {
      const at = path ? `${path}.${name}` : name;
      const normalized = normalizedName(name);
      const description = typeof child?.description === "string" ? child.description : "";
      if (credentialName(name)) fields.add(at);
      else if (CREDENTIAL_DESCRIPTION.test(description) && !metadataName(name)) fields.add(at);
      else if (keyed && ["value", "vsmvalue", "legacyvalue", "decryptedvalue"].includes(normalized)) fields.add(at);
      else if (ENV_CONTAINERS.includes(normalized)) fields.add(at);
      else if (
        URL_NAMES.includes(normalized) &&
        (/secret|token|credential|auth/i.test(description) || ["deployhooks", "delivery"].includes(parent))
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
 * field (by name or by description), whose path, operationId, or summary
 * names a secret family, or whose description says it issues something a
 * holder can use (a code, token, key, or link that is valid or accepted):
 * `{ "METHOD /path": { fields: [...], named: boolean } }`, sorted.
 */
export function valueSafetyCandidates(document, options = {}) {
  // A vendor's own secret families whose responses carry free-form values
  // (Vercel's Global Config items) are named in its source record.
  const vendorWords = typeof options.operationWords === "string" ? new RegExp(options.operationWords, "i") : undefined;
  const out = {};
  for (const path of Object.keys(document.paths ?? {}).sort()) {
    const item = document.paths[path];
    for (const verb of VERBS) {
      const operation = item?.[verb];
      if (!operation || typeof operation !== "object" || operation.deprecated === true) continue;
      const fields = new Set();
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (!status.startsWith("2")) continue;
        let resolved = response;
        while (resolved && typeof resolved.$ref === "string") resolved = pointer(document, resolved.$ref);
        for (const media of Object.values(resolved?.content ?? {})) {
          for (const field of flaggedFields(document, media?.schema)) fields.add(field);
        }
      }
      const text = `${path} ${operation.operationId ?? ""} ${operation.summary ?? ""}`;
      const description = typeof operation.description === "string" ? operation.description : "";
      const named =
        OPERATION_WORDS.test(text) || ISSUING_DESCRIPTION.test(description) || (vendorWords?.test(text) ?? false);
      if (fields.size > 0 || named) out[`${verb.toUpperCase()} ${path}`] = { fields: [...fields].sort(), named };
    }
  }
  return out;
}

/** The committed candidates file: the pin it was derived from, and the flagged operations. */
export function renderValueSafety(document, source) {
  const options = typeof source.options?.valueSafety === "object" ? source.options.valueSafety : {};
  return `${JSON.stringify(
    { format: VALUE_SAFETY_FORMAT, digest: source.digest, candidates: valueSafetyCandidates(document, options) },
    null,
    2,
  )}\n`;
}
