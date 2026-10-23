// The provider standard of decision 0011 (decisions/0011-provider-standard.md):
// the rule checks, and the one list of providers that have not reached it yet.
//
// Rule ids match the record: L folder layout, E evidence, D drift.json, G the
// maintained guide, S the agent-facing surface. Step 1 (onto the kit, agent
// output unchanged) answers to L, E and D; step 2 (the agent-facing surface)
// adds G and S. The checks are plain functions over plain data, so the
// Node-only folder suite (`provider-standard.node.test.ts`), the
// conventions suite, and `providers:generate` (which refuses D past step 1
// and G past step 2) apply the same rules.

/**
 * Providers that have not landed a step yet. Each list only shrinks: a
 * migration PR removes its provider, and `provider-standard.node.test.ts`
 * checks the current inventory and fails while a listed provider already passes, so an exemption cannot
 * outlive its reason. A name never joins these lists. A provider folder
 * created after them meets the whole standard from its first commit.
 */
import {
  driftRecordProblems,
  generatedProblems,
  supplementalDocument,
  validSupplementalPin,
} from "../scripts/drift-validate.mjs";
import type { Connector, ConnectorContext } from "../src/types.js";

export const PENDING = {
  /** Not yet on the kit and the standard layout, evidence and drift record. */
  step1: new Set(["docs", "drive", "forms", "github", "gmail", "mixpanel", "sheets", "slides", "vercel"]),
  /** Agent-facing surface and guide not yet standard. Always contains step1. */
  step2: new Set([
    "breeze",
    "ccb",
    "cloudflare",
    "docs",
    "drive",
    "forms",
    "github",
    "gmail",
    "infisical",
    "mixpanel",
    "notion",
    "overflow",
    "planning-center",
    "sheets",
    "slides",
    "stripe",
    "tithely",
    "vercel",
  ]),
} as const;

/** Independent of optional H-convention metadata; omission must never skip the S checks. */
export async function authoredTools(
  _kind: string,
  fixture: { readonly name: string; readonly createAuthored?: () => Pick<Connector, "listTools"> } | undefined,
  context: ConnectorContext,
): Promise<readonly ToolFacts[] | undefined> {
  if (!fixture?.createAuthored)
    throw new Error(`S: ${fixture?.name ?? _kind} needs an offline createAuthored() fixture`);
  const tools = await fixture.createAuthored().listTools(context);
  if (!tools.length)
    throw new Error(`S: ${fixture.name} createAuthored() must expose every authored tool, not an empty catalog`);
  return tools;
}

/** What the rules read about one provider folder. */
export interface ProviderFacts {
  readonly name: string;
  /** `definition.kind` from the provider's factory. */
  readonly kind: string;
  /** Display name: `definition.readme ?? definition.title`. */
  readonly display: string;
  /** Every file in the folder, relative to it and "/"-separated. */
  readonly files: readonly string[];
  /** A file's text, or undefined when the folder has no such file. */
  readonly read: (path: string) => string | undefined;
  /** `definition.blocks.keys`: the guide's declared when-block keys, if any. */
  readonly blockKeys?: readonly string[];
}

/** The parts of a served tool the S rules read. */
export interface ToolFacts {
  readonly name: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
}

const ROOT_FILES = new Set([
  "index.ts",
  "api.ts",
  "tools.ts",
  "safety.ts",
  "SKILL.md",
  "drift.json",
  "fixtures.ts",
  "skill.generated.ts",
  "openapi.generated.ts",
]);
const TEST_FILE = /^provider(?:\.[a-z][a-z0-9-]*)?(?:\.node)?\.test\.ts$/;
const EVIDENCE_FILES = new Set(["openapi.json", "openapi.document.json", "value-safety.json", "review.md"]);
/** Evidence whose bytes `providers:generate` hashes into drift.json. */
const KIND_FILES: Readonly<Record<string, { required: string[]; forbidden: string[] }>> = {
  api: { required: ["api.ts", "tools.ts"], forbidden: ["hosted.ts"] },
};
const CHECK_TYPES = new Set(["endpoints", "versioned-endpoints", "openapi-index", "manual"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Json = Record<string, unknown>;

function record(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function day(value: unknown, today: string): boolean {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value) && value <= today;
}

/** Every key at any depth, for the renamed-key checks. */
function keysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysDeep(item, into);
  else if (record(value)) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keysDeep(child, into);
    }
  }
  return into;
}

/** L: one fixed folder layout per kind. */
export function layoutViolations(provider: ProviderFacts): string[] {
  const found: string[] = [];
  const has = (path: string) => provider.files.includes(path);
  for (const file of provider.files) {
    const [top, ...rest] = file.split("/");
    if (rest.length === 0) {
      if (!ROOT_FILES.has(file) && !TEST_FILE.test(file)) found.push(`L1: ${file} is not a standard root file`);
    } else if (top === "lib") {
      if (!file.endsWith(".ts")) found.push(`L1: ${file}: lib/ holds TypeScript modules only`);
    } else if (top !== "evidence") {
      found.push(`L1: ${top}/ is not evidence/ or lib/`);
    }
  }
  const kind = KIND_FILES[provider.kind];
  if (!kind) found.push(`L2: kind "${provider.kind}" is not "api"`);
  for (const file of kind?.required ?? []) if (!has(file)) found.push(`L2: kind "${provider.kind}" needs ${file}`);
  for (const file of kind?.forbidden ?? []) if (has(file)) found.push(`L2: kind "${provider.kind}" has no ${file}`);
  const index = provider.read("index.ts") ?? "";
  if (/\basProviderFactory\s*\(/.test(index)) found.push("L3: index.ts uses asProviderFactory, not defineProvider");
  if (/\binputSchema\b/.test(index)) found.push("L3: index.ts defines tools; they belong in tools.ts");
  if (/\bremoteMcp\s*\(/.test(index))
    found.push("L3: index.ts configures remoteMcp(); hosted servers use generic remoteMcp() entries");
  for (const file of ["index.ts", "SKILL.md", "drift.json", "fixtures.ts", "skill.generated.ts"]) {
    if (!has(file)) found.push(`L4: missing ${file}`);
  }
  if (!has("provider.test.ts") && !has("provider.node.test.ts")) found.push("L4: missing provider.test.ts");
  if (has("openapi.generated.ts") !== has("evidence/openapi.json")) {
    found.push("L4: openapi.generated.ts exists exactly when evidence/openapi.json does");
  }
  return found;
}

/** E: fixed evidence names and formats. */
export function evidenceViolations(provider: ProviderFacts, _today: string): string[] {
  const found: string[] = [];
  const has = (path: string) => provider.files.includes(path);
  const drift = parse(provider.read("drift.json"));
  const pins = new Set<string>();
  if (record(drift) && Array.isArray(drift["checks"])) {
    for (const check of drift["checks"]) {
      if (!record(check) || !record(check["specification"])) continue;
      const pin = check["specification"]["pin"];
      if (typeof pin !== "string") continue;
      const document = supplementalDocument(pin);
      if (!document) {
        found.push("E3: supplemental pin needs a simple non-reserved filename");
        continue;
      }
      pins.add(pin);
      pins.add(document);
      const value = parse(provider.read(`evidence/${pin}`));
      const evidence =
        record(drift["generated"]) && record(drift["generated"]["evidence"]) ? drift["generated"]["evidence"] : {};
      if (
        !validSupplementalPin(value) ||
        !record(value) ||
        value["digest"] !== evidence[document] ||
        !has(`evidence/${document}`)
      )
        found.push(
          "E3: supplemental pin needs https url/documentation, vendored: true and its matching document digest",
        );
    }
  }
  for (const file of provider.files) {
    if (!file.startsWith("evidence/")) continue;
    const name = file.slice("evidence/".length);
    if (!EVIDENCE_FILES.has(name) && !pins.has(name) && !name.startsWith("pages/"))
      found.push(`E1: ${file} is not a standard evidence name`);
  }
  if (has("evidence/openapi.json")) {
    const pin = parse(provider.read("evidence/openapi.json"));
    if (
      !record(pin) ||
      typeof pin["url"] !== "string" ||
      !pin["url"].startsWith("https://") ||
      typeof pin["revision"] !== "string" ||
      !pin["revision"] ||
      typeof pin["digest"] !== "string" ||
      !SHA256.test(pin["digest"])
    ) {
      found.push("E3: evidence/openapi.json needs an https url, a revision, and a sha256 digest");
    }
    if (record(pin) && (pin["vendored"] === true) !== has("evidence/openapi.document.json")) {
      found.push("E3: evidence/openapi.document.json exists exactly when the pin says vendored: true");
    }
  } else if (has("evidence/openapi.document.json")) {
    found.push("E3: evidence/openapi.document.json needs its pin in evidence/openapi.json");
  }
  if (has("evidence/value-safety.json")) {
    const candidates = parse(provider.read("evidence/value-safety.json"));
    if (
      !record(candidates) ||
      typeof candidates["format"] !== "number" ||
      typeof candidates["digest"] !== "string" ||
      !SHA256.test(candidates["digest"]) ||
      !record(candidates["candidates"])
    ) {
      found.push("E3: evidence/value-safety.json is the generated candidates file (format, digest, candidates)");
    }
    if (!has("safety.ts")) found.push("E3: evidence/value-safety.json needs its reviewed table in safety.ts");
  }
  if (provider.files.some((file) => file.startsWith("evidence/pages/"))) {
    const recording = parse(provider.read("evidence/pages/recording.json"));
    const pages = record(recording) && Array.isArray(recording["pages"]) ? (recording["pages"] as unknown[]) : [];
    if (
      !pages.length ||
      !pages.every(
        (page) =>
          record(page) &&
          typeof page["file"] === "string" &&
          has(`evidence/pages/${page["file"]}`) &&
          typeof page["url"] === "string" &&
          typeof page["sha256"] === "string",
      )
    ) {
      found.push("E3: evidence/pages/recording.json must list every recorded page with its url and sha256");
    }
  }
  if (has("evidence/review.md") && !provider.read("evidence/review.md")?.trim()) {
    found.push("E3: evidence/review.md is empty");
  }
  return found;
}

/**
 * D: drift.json v2. Humans write sources, reasons, and dates; tools write
 * lists and digests. A record that meets these rules must also be one
 * `providers:check` can read, by the validator it uses (drift-validate.mjs).
 * `recording` admits an endpoint row awaiting the contract `--record` writes:
 * `providers:generate` passes it, so a new operation's row can be generated
 * and then recorded, while this suite requires every contract.
 */
export function driftViolations(
  provider: ProviderFacts,
  today: string,
  { recording = false }: { recording?: boolean } = {},
): string[] {
  const found: string[] = [];
  const drift = parse(provider.read("drift.json"));
  if (!record(drift) || drift["version"] !== 2 || drift["provider"] !== provider.name) {
    return ["D1: drift.json needs version 2 and this provider's name"];
  }
  const generated = drift["generated"];
  found.push(...generatedProblems(drift, { kind: provider.kind, files: provider.files }));
  const checks = drift["checks"];
  if (!Array.isArray(checks)) return [...found, "D3: drift.json needs a checks array"];
  const operations = new Set(
    record(generated) && Array.isArray(generated["operations"]) ? generated["operations"] : [],
  );
  for (const [index, check] of checks.entries()) {
    const at = `checks[${index}]`;
    if (!record(check) || !CHECK_TYPES.has(String(check["type"]))) {
      found.push(`D3: ${at} has an unknown type`);
      continue;
    }
    const keys = keysDeep(check);
    if (keys.has("rationale") || keys.has("reviewedAt")) {
      found.push(`D3: ${at} uses rationale or reviewedAt; v2 names them reason and lastVerified`);
    }
    if (check["type"] === "manual") {
      if (typeof check["source"] !== "string" || !check["source"].startsWith("https://")) {
        found.push(`D3: ${at} manual check needs an https source`);
      }
      if (typeof check["reason"] !== "string" || !check["reason"].trim()) {
        found.push(`D3: ${at} manual check needs a reason`);
      }
      if (!day(check["lastVerified"], today)) {
        found.push(`D3: ${at} manual check needs lastVerified as a past YYYY-MM-DD date`);
      }
    }
    if (keys.has("reviewed")) found.push(`D4: ${at} hand-keeps a reviewed list; hosted reviews were removed`);
    if (check["type"] === "endpoints" || check["type"] === "versioned-endpoints") {
      const entries = Array.isArray(check["endpoints"]) ? check["endpoints"] : [];
      if (
        entries.some(
          (entry) =>
            !record(entry) || "method" in entry || "path" in entry || !operations.has(String(entry["operation"])),
        )
      ) {
        found.push(`D4: ${at} entries are keyed by an operation in generated.operations, never a hand-listed path`);
      }
    }
  }
  if (found.length > 0) return found;
  return driftRecordProblems(drift, provider.name, { today, recording }).map(
    (problem) => `D3: providers:check rejects ${problem}`,
  );
}

/** G: SKILL.md carries agent-facing domain guidance only, rendered by the one guide renderer. */
export function guideViolations(provider: ProviderFacts, documentation: string): string[] {
  const found: string[] = [];
  const source = provider.read("SKILL.md") ?? "";
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  const metadata = parse(frontmatter?.[1]);
  if (
    !record(metadata) ||
    JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(["instructionsHeading", "name"]) ||
    metadata["name"] !== provider.name
  ) {
    found.push("G1: SKILL.md frontmatter declares exactly name and instructionsHeading");
  }
  const body = frontmatter ? source.slice(frontmatter[0].length) : source;
  if (/<!--\s*(?:end)?fragment\b/.test(body)) found.push("G2: SKILL.md uses retired fragment markers");
  let open = false;
  const keys = new Set<string>();
  for (const line of body.split("\n")) {
    const marker = /^<!--\s*(?:when:\s*([a-z][a-z0-9:-]*)|end)\s*-->$/.exec(line.trim());
    if (!marker) {
      if (/<!--\s*(?:when:|end\s*-->)/.test(line)) found.push("G2: a when-block marker stands alone on its line");
      continue;
    }
    if (marker[1] !== undefined ? open : !open) {
      found.push("G2: SKILL.md when-blocks must open and close in turn, unnested");
      break;
    }
    open = marker[1] !== undefined;
    if (marker[1] !== undefined) keys.add(marker[1]);
  }
  if (open) found.push("G2: SKILL.md leaves a when-block open");
  for (const key of keys) {
    if (!provider.blockKeys?.includes(key)) found.push(`G2: SKILL.md uses the undeclared when-block key ${key}`);
  }
  if (/^# /m.test(body)) found.push("G3: SKILL.md headings start at ##; the renderer writes the title");
  if (/^## Conventions\s*$/m.test(body)) found.push("G3: the Conventions section is generated, not written");
  if (/@zackbart\/connecta|^#+ .*\b(?:setup|set up|install|configure|configuration)\b/im.test(body)) {
    found.push("G4: SKILL.md carries operator setup; it belongs in documentation/providers.md");
  }
  if (/\bINV-\d+|\b(?:src|test|scripts)\/[\w./-]+|value[- ]safety/i.test(body)) {
    found.push("G5: SKILL.md carries contributor internals");
  }
  if (/\bskill\.(?:fragments|instructionsHeading)\b/.test(provider.read("index.ts") ?? "")) {
    found.push("G6: index.ts renders its own guide; render through ProviderContext.usageGuide");
  }
  if (!documentation.split(/\r?\n/).includes(`## ${provider.display}`)) {
    found.push(`G7: documentation/providers.md has no "## ${provider.display}" section`);
  }
  return found;
}

const RETIRED_PAGING = new Set([
  "page",
  "perPage",
  "per_page",
  "page_size",
  "pageSize",
  "offset",
  "start_cursor",
  "maxRows",
]);
const PRIVACY_ARGUMENTS = new Set(["raw", "includeSensitive", "sensitiveFields", "unredacted"]);
/** Size-truncation reports that `truncated` replaces; safety and completeness facts keep their names. */
const RETIRED_TRUNCATION = new Set([
  "attachmentsOmitted",
  "bodyTruncated",
  "contentTruncated",
  "itemsTruncated",
  "labelIdsOmitted",
  "labelsOmitted",
  "namedRangesOmitted",
  "repliesOmitted",
  "repliesTruncated",
  "teamMembersTruncated",
  "truncatedCells",
  "truncatedFields",
  "truncated_properties",
]);
const HATCH = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)*)_api_([a-z]+)$/;
const HATCH_TOOLS = new Set(["search", "details", "read", "write", "upload"]);

function properties(schema: unknown): Json {
  return record(schema) && record(schema["properties"]) ? schema["properties"] : {};
}

function hasType(schema: unknown, type: string): boolean {
  return record(schema) && schema["type"] === type;
}

function stringArray(schema: unknown): boolean {
  return hasType(schema, "array") && record(schema) && hasType(schema["items"], "string");
}

function required(schema: unknown, ...names: string[]): boolean {
  const fields = record(schema) ? schema["required"] : undefined;
  return Array.isArray(fields) && names.every((name) => fields.includes(name));
}

/** S: one agent-facing shape across api() surfaces. */
export function surfaceViolations(tools: readonly ToolFacts[]): string[] {
  const found: string[] = [];
  const prefixes = new Set<string>();
  const hatch = new Map<string, ToolFacts>();
  for (const tool of tools) {
    const match = HATCH.exec(tool.name);
    if (!match) continue;
    prefixes.add(match[1]!);
    if (!HATCH_TOOLS.has(match[2]!)) found.push(`S1: ${tool.name} is not a standard hatch tool`);
    else hatch.set(match[2]!, tool);
  }
  if (prefixes.size > 1) found.push(`S1: one hatch prefix per provider, found ${[...prefixes].sort().join(", ")}`);
  if (hatch.size > 0) {
    for (const part of ["search", "details", "read"]) {
      if (!hatch.has(part))
        found.push(`S1: a hatch has _api_search, _api_details, and _api_read; missing _api_${part}`);
    }
    for (const part of ["search", "details", "read"]) {
      const tool = hatch.get(part);
      if (tool && tool.annotations?.readOnlyHint !== true) found.push(`S1: ${tool.name} is annotated read-only`);
    }
    for (const part of ["write", "upload"]) {
      const tool = hatch.get(part);
      if (tool && (tool.annotations?.readOnlyHint !== false || tool.annotations?.destructiveHint !== true)) {
        found.push(`S1: ${tool.name} is annotated destructive`);
      }
    }
  }
  for (const tool of tools) {
    const input = properties(tool.inputSchema);
    const output = properties(tool.outputSchema);
    const match = HATCH.exec(tool.name);
    const isHatch = match !== null;
    const hatchCall = isHatch && ["read", "write", "upload"].includes(match[2]!);
    for (const name of Object.keys(input)) {
      if (RETIRED_PAGING.has(name)) found.push(`S2: ${tool.name} takes ${name}; page with limit and cursor`);
      if (PRIVACY_ARGUMENTS.has(name)) found.push(`S6: ${tool.name} takes ${name}; privacy is deployment config`);
    }
    if ("limit" in input && !hasType(input["limit"], "integer")) {
      found.push(`S2: ${tool.name} limit is an integer`);
    }
    if ("cursor" in input && !hasType(input["cursor"], "string")) {
      found.push(`S2: ${tool.name} cursor is a string`);
    }
    const rows = !isHatch && /^(?:list|search)_/.test(tool.name);
    if (rows && "page" in output) {
      if (!("cursor" in input && "limit" in input)) {
        found.push(`S2: ${tool.name} pages with limit and cursor`);
      }
      const limit = input["limit"];
      if (
        !record(limit) ||
        !Number.isInteger(limit["default"]) ||
        !Number.isInteger(limit["maximum"]) ||
        Number(limit["default"]) < 1 ||
        Number(limit["maximum"]) < Number(limit["default"])
      ) {
        found.push(`S2: ${tool.name} limit declares a positive default and maximum`);
      }
    }
    if ("page" in output) {
      const schema = output["page"];
      const page = properties(schema);
      if (
        !hasType(schema, "object") ||
        !hasType(page["hasMore"], "boolean") ||
        !hasType(page["nextCursor"], "string") ||
        !required(schema, "hasMore") ||
        ("total" in page && !hasType(page["total"], "integer"))
      ) {
        found.push(`S2: ${tool.name} page requires hasMore: boolean, with nextCursor?: string and total?: integer`);
      }
      const allowed = new Set(["hasMore", "nextCursor", "total", ...(hatchCall ? ["param", "in"] : [])]);
      for (const name of Object.keys(page)) {
        if (!allowed.has(name)) found.push(`S2: ${tool.name} page reports retired key ${name}`);
      }
      if (
        hatchCall &&
        (!hasType(page["param"], "string") || !hasType(page["in"], "string") || !required(schema, "param", "in"))
      ) {
        found.push(`S2: ${tool.name} hatch page requires param and in strings`);
      }
    }
    if (
      rows &&
      (!hasType(tool.outputSchema, "object") ||
        !hasType(output["items"], "array") ||
        !("page" in output) ||
        !required(tool.outputSchema, "items", "page"))
    ) {
      found.push(`S3: ${tool.name} returns { items, page }`);
    }
    if (
      hatchCall &&
      (!hasType(tool.outputSchema, "object") ||
        !hasType(output["status"], "integer") ||
        !("data" in output) ||
        !required(tool.outputSchema, "status", "data") ||
        "result" in output)
    ) {
      found.push(`S3: ${tool.name} returns { status: integer, data, page? }, with status and data required`);
    }
    if (
      isHatch &&
      match[2] === "search" &&
      (!hasType(tool.outputSchema, "object") ||
        !hasType(output["operations"], "array") ||
        !hasType(output["revision"], "string") ||
        !required(tool.outputSchema, "operations", "revision"))
    ) {
      found.push(`S3: ${tool.name} returns required operations: array and revision: string`);
    }
    for (const name of Object.keys(output)) {
      if (RETIRED_TRUNCATION.has(name)) found.push(`S3: ${tool.name} reports ${name}; report cut fields in truncated`);
      if (
        name !== "page" &&
        (RETIRED_PAGING.has(name) || ["nextCursor", "nextPage", "nextOffset", "hasMore", "totalCount"].includes(name))
      ) {
        found.push(`S2: ${tool.name} reports ${name} outside page`);
      }
    }
    if ("truncated" in output && !stringArray(output["truncated"])) {
      found.push(`S3: ${tool.name} truncated is a string array of the dot paths it cut`);
    }
    if ("select" in input) found.push(`S5: ${tool.name} takes select; the projection argument is fields`);
    const read = tool.annotations?.readOnlyHint === true;
    const named = !isHatch && /^(?:list|get|search)_/.test(tool.name);
    const projects = isHatch && /_api_(?:read|write)$/.test(tool.name);
    if (((read && named) || projects) && !("fields" in input)) {
      found.push(`S5: ${tool.name} takes fields to narrow its result`);
    } else if ("fields" in input && !stringArray(input["fields"])) {
      found.push(`S5: ${tool.name} fields is a string array of dot paths`);
    }
  }
  return found;
}
