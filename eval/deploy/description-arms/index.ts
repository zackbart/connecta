/**
 * Eval-only description arms. `--description-arm <name>` on `eval:agent` is the
 * one way in: no public option, configuration key or `src/` module can reach
 * this folder, and the package does not ship it.
 *
 * An arm rewrites only the description strings of a provider's tools. Names,
 * types, enums, bounds, required lists, annotations and handlers stay as they
 * are, and nothing outside the six providers in `OVERRIDES` changes. Tool text
 * is hand-written per tool; property text follows the arm's written rules in
 * `properties.ts`, with hand-written per-tool additions.
 *
 * `armViolations` is the validity check: a variant that drops a protected
 * safety rule or required prerequisite is invalid, not a cheaper variant.
 */
import { CCB } from "./ccb.js";
import { CLOUDFLARE } from "./cloudflare.js";
import { GITHUB } from "./github.js";
import { propertyText } from "./properties.js";
import { PROTECTED, type ProtectedClause } from "./protected.js";
import { QUICKBOOKS } from "./quickbooks.js";
import { SHEETS } from "./sheets.js";
import { STRIPE } from "./stripe.js";
import type { ProviderTable, RewrittenArm } from "./types.js";

export const DESCRIPTION_ARMS = ["control", "terse", "disambiguation", "example"] as const;
export type DescriptionArm = (typeof DESCRIPTION_ARMS)[number];

/** Results written before these arms existed served today's text. */
export const descriptionArmOf = (recorded: string | undefined): string => recorded ?? "control";

export function parseDescriptionArm(value = "control"): DescriptionArm {
  if (!DESCRIPTION_ARMS.includes(value as DescriptionArm))
    throw new Error(`--description-arm must be one of ${DESCRIPTION_ARMS.join(", ")}`);
  return value as DescriptionArm;
}

export const OVERRIDES: Readonly<Record<string, ProviderTable>> = {
  stripe: STRIPE,
  github: GITHUB,
  cloudflare: CLOUDFLARE,
  ccb: CCB,
  quickbooks: QUICKBOOKS,
  sheets: SHEETS,
};

interface ToolText {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
}

/** A deep copy of one schema with each property description rewritten or removed. */
function rewriteSchema(schema: unknown, rewrite: (path: string, text: string | undefined) => string | undefined) {
  const visit = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((item) => visit(item, path));
    if (node === null || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === "description") continue;
      if (key === "properties" && value !== null && typeof value === "object") {
        out[key] = Object.fromEntries(
          Object.entries(value).map(([name, child]) => [name, visit(child, path ? `${path}.${name}` : name)]),
        );
      } else if (key === "items") out[key] = visit(value, `${path}[]`);
      else out[key] = visit(value, path);
    }
    if (path) {
      const text = rewrite(path, typeof record["description"] === "string" ? record["description"] : undefined);
      if (text) out["description"] = text;
    } else if (typeof record["description"] === "string") out["description"] = record["description"];
    return out;
  };
  return visit(schema, "");
}

function rewriteTool<T extends ToolText>(tool: T, provider: string, arm: RewrittenArm): T {
  const entry = OVERRIDES[provider]?.tools[tool.name];
  if (!entry) throw new Error(`Description arm ${arm} has no text for ${provider}.${tool.name}`);
  return {
    ...tool,
    description: entry[arm],
    ...(tool.inputSchema === undefined
      ? {}
      : {
          inputSchema: rewriteSchema(tool.inputSchema, (path, text) => {
            const extra = entry.properties?.[arm]?.[path];
            return extra === undefined ? propertyText(arm, text) : extra === null ? undefined : extra;
          }),
        }),
  };
}

/**
 * Apply an arm to one provider connector, in place. `api()` serves its catalog
 * from `staticTools`, so replacing those entries reaches every surface; call
 * dispatch and argument validation keep the handlers' own compiled schemas.
 * Connectors outside the arm's providers are returned untouched.
 */
export function withDescriptionArm<C extends object>(
  connector: C,
  provider: string | undefined,
  arm: DescriptionArm | undefined,
): C {
  if (!arm || arm === "control" || !provider || !OVERRIDES[provider]) return connector;
  const tools = (connector as { staticTools?: ToolText[] }).staticTools;
  if (!tools) throw new Error(`Description arm ${arm} needs the ${provider} connector's static catalog`);
  for (const [index, tool] of tools.entries()) tools[index] = rewriteTool(tool, provider, arm);
  return connector;
}

/** Every string an agent could read from one tool. */
function servedText(tool: ToolText): string {
  const parts = [tool.description ?? ""];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === "object")
      for (const [key, value] of Object.entries(node)) {
        if (key === "description" && typeof value === "string") parts.push(value);
        else visit(value);
      }
  };
  visit(tool.inputSchema);
  return parts.join("\n");
}

const META_TOOL_NAME =
  /\b(?:call_tool|call_destructive_tool|search_tools|execute_code|authorize_connector|read_result)\b/;

function withoutDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDescriptions);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key, value]) => !(key === "description" && typeof value === "string"))
      .map(([key, value]) => [key, withoutDescriptions(value)]),
  );
}

/** The whole `{...}` following `Example:`, read by bracket depth. */
export function exampleArguments(description: string): unknown {
  const start = description.indexOf("Example: {");
  if (start < 0) return undefined;
  const open = start + "Example: ".length;
  let depth = 0;
  let quoted = false;
  for (let index = open; index < description.length; index += 1) {
    const char = description[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(description.slice(open, index + 1));
  }
  throw new Error(`Unterminated example in: ${description}`);
}

/**
 * Why one arm is invalid against one provider's real catalog: a missing or
 * extra tool, a dropped protected clause, a structural schema change, a
 * meta-tool name in static text, or an example that its own schema refuses.
 */
export function armViolations(
  provider: string,
  catalog: readonly ToolText[],
  arm: DescriptionArm,
  validate: (schema: unknown, args: unknown) => string[],
): string[] {
  const table = OVERRIDES[provider];
  if (!table) return [`${provider}: no overrides`];
  const found: string[] = [];
  const names = new Set(catalog.map((tool) => tool.name));
  for (const name of Object.keys(table.tools)) if (!names.has(name)) found.push(`${provider}.${name}: unknown tool`);
  for (const tool of catalog) {
    const id = `${provider}.${tool.name}`;
    if (!table.tools[tool.name]) {
      found.push(`${id}: missing`);
      continue;
    }
    const served = arm === "control" ? tool : rewriteTool(tool, provider, arm);
    const text = servedText(served);
    for (const clause of (PROTECTED[provider]?.[tool.name] ?? []) as readonly ProtectedClause[])
      if (!clause.pattern.test(text)) found.push(`${id}: ${arm} dropped protected clause "${clause.id}"`);
    if (arm === "control") continue;
    if (!served.description?.trim()) found.push(`${id}: ${arm} has an empty description`);
    if (
      JSON.stringify(withoutDescriptions(served.inputSchema)) !== JSON.stringify(withoutDescriptions(tool.inputSchema))
    )
      found.push(`${id}: ${arm} changed more than description text`);
    if (META_TOOL_NAME.test(text)) found.push(`${id}: ${arm} spells a meta tool in static text`);
    if (arm === "example") {
      const example = exampleArguments(served.description ?? "");
      if (example === undefined) found.push(`${id}: example arm has no example`);
      else
        for (const problem of validate(tool.inputSchema, example))
          found.push(`${id}: example fails its own schema: ${problem}`);
    }
  }
  return found;
}

/** The text a tool serves under an arm, for measurement and tests. */
export function toolUnderArm<T extends ToolText>(tool: T, provider: string, arm: DescriptionArm): T {
  return arm === "control" ? tool : rewriteTool(tool, provider, arm);
}
