// The offline structure of a drift.json record, decision 0011 (D) for
// version 2. One validator serves `providers:check` (drift-check.mjs), the
// provider-standard suite (test/provider-standard.ts, on Node and workerd) and
// `providers:generate`, which refuses a record before writing it, so a
// record the generator accepts is one `providers:check` can read. Pure: no
// filesystem, network, or clock beyond the caller's `today`.

export const DRIFT_VERSION = 2;
/** An operation key: `"METHOD /path"`, the kit manifest's spelling. */
export const OPERATION = /^(GET|HEAD|POST|PUT|PATCH|DELETE) (\/\S*)$/;
/** Evidence that is malformed before any vendor is read. */
export class EvidenceError extends Error {}

/** `{ method, path }` of an operation key, or undefined when it is not one. */
export function parseOperation(key) {
  const match = typeof key === "string" ? OPERATION.exec(key) : null;
  return match ? { method: match[1], path: match[2] } : undefined;
}

/** Whole days from a `YYYY-MM-DD` day to `now`, in UTC. */
export function daysSince(day, now = new Date()) {
  return Math.floor((now.getTime() - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
}

/** `/people/v2/people/{person_id}` → `people`; the version segment is fixed. */
export function productOf(path) {
  return /^\/([a-z-]+)\/v2(?:\/|$)/.exec(path)?.[1];
}

function require(condition, detail) {
  if (!condition) throw new EvidenceError(detail);
}

/** A record's version, provider, and non-empty checks; version 2 adds its generated block. */
export function validateRecord(record, name) {
  require((record?.version === 1 || record?.version === DRIFT_VERSION) &&
    record.provider === name &&
    Array.isArray(record.checks) &&
    record.checks.length >
      0, `${name}'s drift record requires version 1 or 2, matching provider, and non-empty checks`);
  if (record.version === DRIFT_VERSION) validateGenerated(record);
}

/** D2 checks; folder context also verifies provider kind and evidence-file coverage. */
export function generatedProblems(recordValue, { kind, files } = {}) {
  const found = [];
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const sortedUnique = (value) =>
    Array.isArray(value) && value.every((item, i) => typeof item === "string" && (i === 0 || value[i - 1] < item));
  const SHA256 = /^sha256:[0-9a-f]{64}$/;
  const HASHED_EVIDENCE = ["catalog.json", "openapi.json", "openapi.document.json", "value-safety.json"];
  const generated = recordValue.generated;
  if (!record(generated) || Object.keys(generated).some((key) => !["operations", "hosted", "evidence"].includes(key))) {
    found.push("D2: drift.json needs a generated block of operations, hosted, and evidence only");
  } else {
    const operations = generated["operations"];
    if (kind !== "mcp" && !(sortedUnique(operations) && operations.every((key) => OPERATION.test(key)))) {
      found.push('D2: generated.operations lists the kit manifest as sorted "METHOD /path" keys');
    }
    const hosted = generated["hosted"];
    if (!sortedUnique(hosted) || (kind === "api" ? hosted.length !== 0 : kind !== undefined && hosted.length === 0)) {
      found.push("D2: generated.hosted lists served hosted names, sorted; api providers have no hosted names");
    }
    const evidence = generated["evidence"];
    const expected = files && HASHED_EVIDENCE.filter((name) => files.includes(`evidence/${name}`));
    if (
      !record(evidence) ||
      (expected && JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(expected.sort())) ||
      !Object.values(evidence).every((digest) => typeof digest === "string" && SHA256.test(digest))
    ) {
      found.push("D2: generated.evidence holds one sha256 per hashed evidence file");
    }
  }
  return found;
}

/** A version-2 record's generated block, which only providers:generate writes. */
function validateGenerated(record) {
  const problems = generatedProblems(record);
  require(problems.length === 0, problems.join("; "));
}

/** Reject version-2 evidence that keeps a version-1 shape (decision 0011, D3 and D4). */
function validateV2Check(record, check, today) {
  require(check && typeof check === "object", "check must be an object");
  const keys = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        walk(child);
      }
    }
  };
  walk(check);
  require(!keys.has("rationale") &&
    !keys.has("reviewedAt"), "version 2 renames rationale to reason and reviewedAt to lastVerified");
  require(!keys.has("reviewed"), "version 2 keeps no reviewed list: hosted names are generated.hosted");
  if (check.type === "manual") {
    const day = check.lastVerified;
    require(typeof check.source === "string" &&
      check.source.startsWith("https://"), "manual check requires an https source");
    require(typeof check.reason === "string" && check.reason.trim(), "manual check requires a reason");
    require(typeof day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      new Date(`${day}T00:00:00Z`).toISOString().startsWith(day) &&
      day <= today, "manual check requires lastVerified as a past YYYY-MM-DD day");
  }
  if (check.type === "mcp-docs") {
    const hosted = new Set(record.generated.hosted);
    require(Object.keys(check.reviewedAccess ?? {}).every((name) =>
      hosted.has(name),
    ), "reviewed access must name generated hosted tools");
  }
  if (check.type === "endpoints" || check.type === "versioned-endpoints") {
    require(Array.isArray(check.endpoints) && check.endpoints.length > 0, "endpoint check requires touched endpoints");
    const operations = new Set(record.generated.operations);
    const pages = check.specification?.format === "readme-operation-pages";
    for (const entry of check.endpoints) {
      require(entry &&
        !("method" in entry) &&
        !("path" in entry) &&
        operations.has(entry.operation), "endpoint rows are keyed by an operation in generated.operations");
      require(!pages ||
        (typeof entry.page === "string" && entry.page.trim()), `${entry.operation} names its reference page`);
    }
    require(!pages || check.specification.pages === undefined, "reference pages belong to each endpoint row");
  }
}

/**
 * A check as the version-1 checkers read it. Version 2 keeps no hand-typed
 * lists, so its hosted names, endpoint rows and reference pages come from
 * the generated block and the rows.
 * `today` is the `YYYY-MM-DD` day a manual check is checked
 * against.
 */
export function checkView(record, check, { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (record.version !== DRIFT_VERSION) return check;
  validateV2Check(record, check, today);
  if (check.type === "manual") return { ...check, rationale: check.reason };
  if (check.type === "mcp-docs") {
    return { ...check, reviewed: record.generated.hosted };
  }
  if (check.type === "endpoints" || check.type === "versioned-endpoints") {
    const endpoints = check.endpoints.map(({ operation, ...row }) => ({ ...parseOperation(operation), ...row }));
    const pages = check.specification?.format === "readme-operation-pages";
    return {
      ...check,
      ...(pages
        ? { specification: { ...check.specification, pages: [...new Set(check.endpoints.map((row) => row.page))] } }
        : {}),
      endpoints,
    };
  }
  return check;
}

/**
 * Reject missing vendor evidence before network access; config is never
 * guessed. `recording` admits an endpoint row whose contract `--record` has
 * not yet written.
 */
export function validateCheck(check, recording, version = 1) {
  const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
  const strings = (value) =>
    Array.isArray(value) && value.length > 0 && value.every(nonempty) && new Set(value).size === value.length;
  require(check && typeof check === "object", "check must be an object");
  if (check.type === "manual") {
    require(nonempty(check.source) && nonempty(check.rationale), "manual check requires source and rationale");
    return;
  }
  if (check.type === "openapi-index") {
    const pin = version === DRIFT_VERSION ? "evidence/openapi.json" : "openapi.source.json";
    require(check.source === pin, `OpenAPI index check reads ${pin}`);
    return;
  }
  if (check.type === "mcp-docs") {
    require(nonempty(check.setup) &&
      strings(check.endpoints) &&
      strings(check.reviewed), "MCP check requires setup, endpoints, and reviewed vendor names");
    if (check.reviewedAccess !== undefined) {
      require(check.reviewedAccess !== null &&
        typeof check.reviewedAccess === "object" &&
        !Array.isArray(check.reviewedAccess) &&
        Object.entries(check.reviewedAccess).every(
          ([name, access]) => check.reviewed.includes(name) && (access === "read" || access === "write"),
        ), "reviewed access must map reviewed names to read or write");
    }
    if (check.inventory !== undefined) {
      const inventory = check.inventory;
      require(nonempty(inventory.url) &&
        ["headings", "inline", "inline-calls", "table", "vercel-categories"].includes(
          inventory.format,
        ), "inventory requires URL and supported parser format");
      for (const key of ["start", "end", "prefix", "accessColumn"])
        require(inventory[key] === undefined || nonempty(inventory[key]), `inventory ${key} must be non-empty`);
      require(inventory.categories === undefined ||
        (inventory.format === "vercel-categories" &&
          inventory.categories !== null &&
          typeof inventory.categories === "object" &&
          !Array.isArray(inventory.categories) &&
          Object.entries(inventory.categories).every(
            ([category, names]) => /^[a-z0-9-]+$/.test(category) && strings(names),
          )), "inventory categories must map category slugs to known tool names");
      require(inventory.acknowledgedRemoved === undefined ||
        (inventory.format === "vercel-categories" &&
          strings(inventory.acknowledgedRemoved) &&
          inventory.acknowledgedRemoved.every((name) =>
            check.reviewed.includes(name),
          )), "acknowledged removed names must be unique reviewed names");
      require(inventory.acknowledgedUnclassified === undefined ||
        strings(
          inventory.acknowledgedUnclassified,
        ), "acknowledged unclassified names must be unique non-empty strings");
    }
    return;
  }
  require(check.type === "endpoints" ||
    check.type === "versioned-endpoints", `unknown check type: ${String(check.type)}`);
  require(Array.isArray(check.endpoints) && check.endpoints.length > 0, "endpoint check requires touched endpoints");
  const seen = new Set();
  for (const endpoint of check.endpoints) {
    require(endpoint &&
      /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(endpoint.method) &&
      nonempty(endpoint.path) &&
      endpoint.path.startsWith("/") &&
      nonempty(endpoint.specRevision), "endpoint requires method, path, and reviewed revision");
    const key = `${endpoint.method} ${endpoint.path}`;
    require(!seen.has(key), `duplicate endpoint: ${key}`);
    seen.add(key);
    require((recording && endpoint.contract === undefined) ||
      /^sha256:[0-9a-f]{64}$/.test(endpoint.contract), `invalid contract digest: ${key}`);
    require(endpoint.deprecated === undefined ||
      typeof endpoint.deprecated === "boolean", `invalid deprecation evidence: ${key}`);
  }
  if (check.type === "endpoints") {
    require(nonempty(check.specification?.url), "endpoint check requires specification URL");
    require(check.specification.format === undefined ||
      ["openapi", "google-discovery", "readme-operation-pages"].includes(
        check.specification.format,
      ), "unknown specification format");
    if (check.specification.format === "readme-operation-pages")
      require(strings(check.specification.pages), "operation-page check requires reference pages");
    if (check.specification.format === "google-discovery")
      require(strings(check.scopes), "Google Discovery check requires requested scopes");
  } else {
    require(check.specifications &&
      typeof check.specifications === "object" &&
      !Array.isArray(check.specifications) &&
      Object.keys(check.specifications).length > 0, "versioned check requires per-product specifications");
    for (const [app, spec] of Object.entries(check.specifications)) {
      require(nonempty(spec?.url) &&
        nonempty(spec.documentation) &&
        nonempty(spec.version), `product ${app} requires URL, documentation, and pin`);
      require(spec.latestPublished === undefined ||
        nonempty(spec.latestPublished), `product ${app} has invalid reviewed publication`);
    }
    for (const endpoint of check.endpoints)
      require(Object.hasOwn(
        check.specifications,
        productOf(endpoint.path),
      ), `no product specification for ${endpoint.path}`);
  }
}

/**
 * Every structural problem `providers:check` would report for a record
 * before reading a vendor, as `checks[<index>]: <detail>` (or the detail
 * alone for the record itself). Empty when the record is readable.
 */
export function driftRecordProblems(record, name, { today, recording = false } = {}) {
  try {
    validateRecord(record, name);
  } catch (error) {
    return [error.message];
  }
  const problems = [];
  for (const [index, check] of record.checks.entries()) {
    try {
      validateCheck(checkView(record, check, { today }), recording, record.version);
    } catch (error) {
      problems.push(`checks[${index}]: ${error.message}`);
    }
  }
  return problems;
}
