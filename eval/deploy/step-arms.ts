/**
 * Eval-only step-reduction arms. No package entry exports this module and no
 * configuration key selects it: an arm wraps a deployment's `fetch` and guest
 * bridge from the harness, after Connecta's own dispatch, admission, refusal
 * and value-safety boundaries. Lookups use the caller's own real read routes,
 * so they keep its pool scoping and never reach a vendor. Node-free: the
 * workerd composition bundles it.
 *
 * - `teach-errors`: `invalid_args` and `unknown_tool` carry the compact schema
 *   and the connector's relevant rule; guide pointers leave rows that do not
 *   require them. `guideRequired` rows are never changed.
 * - `ready-rows`: `*_api_search` rows carry accepted parameters and a call.
 * - `next-hints`: reviewed list tools name the tool that reads one record.
 * - `merged-tools`: Vercel's overlapping env and log tools become one each.
 */
import type { Connecta } from "@zackbart/connecta";
import type { Surface } from "../agent/surface.js";

export const STEP_ARMS = ["control", "teach-errors", "ready-rows", "next-hints", "merged-tools"] as const;
export type StepArm = (typeof STEP_ARMS)[number];

export function parseStepArm(value: string | undefined): StepArm | undefined {
  if (value === undefined) return undefined;
  if (!STEP_ARMS.includes(value as StepArm)) throw new Error(`--step-arm must be one of ${STEP_ARMS.join(", ")}`);
  return value as StepArm;
}

/** An arm changes six-tool replies only; another surface would measure two changes at once. */
export function stepArmRefusal(arm: StepArm | undefined, surface: Surface): string | undefined {
  return arm !== undefined && surface !== "six" ? `--step-arm needs --surface six, not ${surface}` : undefined;
}

type Json = Record<string, any>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** 0014's discovery budget for one search answer; the error envelope keeps its 4 KiB budget. */
const SEARCH_BYTES = 16 * 1024;
const TEACH_BYTES = 4 * 1024;
const RULE_CHARS = 320;

/* ------------------------------------------------------------- merged tools */

const VERCEL = "vercel_rest";
const ENV_TOOL = "upsert_project_env";
const LOG_TOOL = "get_logs";
const ENV_ORIGINALS = ["upsert_project_env_var", "update_project_env_var"];
const LOG_ORIGINALS = ["get_deployment_build_logs", "get_runtime_logs"];
const RENAMES = new RegExp(`\\b(${[...ENV_ORIGINALS, ...LOG_ORIGINALS].join("|")})\\b`, "g");
const renameOriginal = (name: string) => (ENV_ORIGINALS.includes(name) ? ENV_TOOL : LOG_TOOL);

const TEAM = { teamId: { type: ["string", "null"] }, slug: { type: "string", minLength: 1 } };
const MERGED: Record<string, { description: string; compact: string; json: Json; write: boolean; output: string[] }> = {
  [ENV_TOOL]: {
    description:
      "Create, replace or update one Vercel project environment variable. Pass envVarId from list_project_env_vars to update only the fields you send; omit it to create or replace by key, which needs key, value, type and targets. Changes affect only future deployments; returns metadata without the value.",
    compact:
      '{ projectId: string, envVarId?: string /* update this id; omit to create */, teamId?: string | null, slug?: string, key?: string, value?: string /* write-only */, type?: "plain" | "encrypted" | "sensitive", targets?: ("production" | "preview" | "development")[], gitBranch?: string | null, customEnvironmentIds?: string[], comment?: string, upsert?: boolean /* create only; false refuses to overwrite */ }',
    json: {
      type: "object",
      additionalProperties: false,
      required: ["projectId"],
      properties: {
        projectId: { type: "string", minLength: 1 },
        envVarId: { type: "string", minLength: 1, description: "Update this id; omit to create." },
        ...TEAM,
        key: { type: "string", minLength: 1, maxLength: 256 },
        value: { type: "string", writeOnly: true, maxLength: 65536 },
        type: { type: "string", enum: ["plain", "encrypted", "sensitive"] },
        targets: { type: "array", items: { type: "string", enum: ["production", "preview", "development"] } },
        gitBranch: { type: ["string", "null"] },
        customEnvironmentIds: { type: "array", items: { type: "string" } },
        comment: { type: "string", maxLength: 500 },
        upsert: { type: "boolean", description: "Create only; false refuses to overwrite." },
      },
    },
    write: true,
    output: ["id", "key", "type", "target", "comment"],
  },
  [LOG_TOOL]: {
    description:
      'Read one Vercel deployment\'s logs. kind "build" returns bounded build events; kind "runtime" collects the runtime stream for at most waitMs or limit and needs projectId. Never follows live output.',
    compact:
      '{ kind: "build" | "runtime", deploymentId: string, projectId?: string /* runtime */, teamId?: string | null, slug?: string, limit?: integer, buildId?: string /* build */, direction?: "forward" | "backward" /* build */, since?: number /* build */, until?: number /* build */, waitMs?: integer /* runtime, 1000-20000 */, levels?: ("debug" | "info" | "warning" | "error" | "fatal" | "trace")[] /* runtime */, fields?: string[] }',
    json: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "deploymentId"],
      properties: {
        kind: { type: "string", enum: ["build", "runtime"] },
        deploymentId: { type: "string", minLength: 1 },
        projectId: { type: "string", minLength: 1 },
        ...TEAM,
        limit: { type: "integer", minimum: 1 },
        buildId: { type: "string", minLength: 1 },
        direction: { type: "string", enum: ["forward", "backward"] },
        since: { type: "number" },
        until: { type: "number" },
        waitMs: { type: "integer", minimum: 1000, maximum: 20000 },
        levels: { type: "array", items: { type: "string" } },
        fields: { type: "array", items: { type: "string" } },
      },
    },
    write: false,
    output: ["events", "logs", "page"],
  },
};

/**
 * Catalog bytes before and after, measured fairly: each merged tool's schema is
 * the union of its originals' properties with their full descriptions, plus
 * `kind`, rather than the arm's shorter hand-written text.
 */
export function mergedCatalog(tools: readonly { name: string; inputSchema?: unknown }[]): {
  before: number;
  after: number;
} {
  const groups: Record<string, string[]> = { [ENV_TOOL]: ENV_ORIGINALS, [LOG_TOOL]: LOG_ORIGINALS };
  const original = new Set(Object.values(groups).flat());
  const after = [
    ...tools.filter((tool) => !original.has(tool.name)),
    ...Object.entries(MERGED).map(([name, tool]) => {
      const properties = Object.assign(
        {},
        ...tools
          .filter((candidate) => groups[name]!.includes(candidate.name))
          .map((candidate) => (candidate.inputSchema as Json | undefined)?.properties ?? {}),
      ) as Json;
      return {
        name,
        description: tool.description,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: tool.json.required,
          properties: { ...(name === LOG_TOOL ? { kind: tool.json.properties.kind } : {}), ...properties },
        },
        annotations: { readOnlyHint: !tool.write, destructiveHint: tool.write },
      };
    }),
  ];
  return { before: bytes(tools), after: bytes(after) };
}

/** A merged call dispatches to the real tool; an original address is hidden like any absent tool. */
function mergedDispatch(address: unknown, args: unknown): { address: string; args: Json } | undefined {
  if (typeof address !== "string" || !address.startsWith(`${VERCEL}.`)) return undefined;
  const tool = address.slice(VERCEL.length + 1);
  const input = isObject(args) ? args : {};
  if (ENV_ORIGINALS.includes(tool) || LOG_ORIGINALS.includes(tool))
    return { address: `${VERCEL}.eval_unavailable_tool`, args: input };
  if (tool === ENV_TOOL) {
    if (input.envVarId === undefined) return { address: `${VERCEL}.upsert_project_env_var`, args: input };
    const { upsert: _upsert, ...update } = input;
    return { address: `${VERCEL}.update_project_env_var`, args: update };
  }
  if (tool === LOG_TOOL) {
    const { kind, ...rest } = input;
    if (kind === "runtime") return { address: `${VERCEL}.get_runtime_logs`, args: rest };
    // An absent or unknown kind stays in the arguments, so the real validator refuses it.
    return {
      address: `${VERCEL}.get_deployment_build_logs`,
      args: kind === "build" ? rest : { ...rest, kind: kind ?? null },
    };
  }
  return undefined;
}

function renamed<T>(value: T): T {
  if (typeof value === "string") return value.replace(RENAMES, renameOriginal) as T;
  if (Array.isArray(value)) return value.map(renamed) as T;
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renamed(item)])) as T;
}

function mergedRows(rows: unknown[]): unknown[] {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (!isObject(row) || typeof row.address !== "string") return [row];
    const [connector, tool] = [
      row.address.slice(0, row.address.indexOf(".")),
      row.address.slice(row.address.indexOf(".") + 1),
    ];
    if (connector !== VERCEL || ![...ENV_ORIGINALS, ...LOG_ORIGINALS].includes(tool)) return [row];
    const name = renameOriginal(tool);
    if (seen.has(name)) return [];
    seen.add(name);
    const merged = MERGED[name]!;
    return [
      {
        ...row,
        name,
        address: `${VERCEL}.${name}`,
        description: merged.description,
        ...(row.inputSchema === undefined
          ? {}
          : { inputSchema: typeof row.inputSchema === "string" ? merged.compact : merged.json }),
        ...(row.outputSchema === undefined ? {} : { outputSchema: undefined }),
        ...(row.inputKeys === undefined
          ? {}
          : { inputKeys: Object.keys(merged.json.properties), requiredInputKeys: merged.json.required }),
        ...(row.outputKeys === undefined ? {} : { outputKeys: merged.output }),
      },
    ];
  });
}

/* --------------------------------------------------------------- next hints */

interface Hint {
  /** The tool reading one record, on the same connector. */
  tool: string;
  /** The argument that takes each row's id. */
  arg: string;
  /** Row field holding that id; `id` by default. */
  field?: string;
  /** Literal args an agent copies, such as a hatch path template. */
  template?: Json;
}
/** Reviewed against each provider's tools.ts and fake rows; see the selftest. */
export const NEXT_HINTS: Readonly<Record<string, Readonly<Record<string, Hint>>>> = {
  ccb: {
    list_individuals: { tool: "get_individual", arg: "individualId" },
    list_families: { tool: "get_family", arg: "familyId" },
    list_groups: { tool: "list_group_members", arg: "groupId" },
    list_events: { tool: "get_event", arg: "eventId" },
  },
  pco: {
    search_people: { tool: "get_person", arg: "personId" },
    list_service_types: { tool: "list_plans", arg: "serviceTypeId" },
    list_groups: { tool: "list_group_memberships", arg: "groupId" },
  },
  breeze: {
    list_people: { tool: "get_person", arg: "personId" },
    list_tags: { tool: "list_people", arg: "tagId" },
    list_events: { tool: "list_attendance", arg: "instanceId" },
  },
  cloudflare_prod: {
    list_accounts: { tool: "list_zones", arg: "accountId" },
    list_zones: {
      tool: "cloudflare_api_read",
      arg: "zone_id",
      template: { path: "/zones/{zone_id}/dns_records" },
    },
  },
};

export function hinted(address: string, data: unknown): unknown {
  const dot = address.indexOf(".");
  const connector = address.slice(0, dot);
  const hint = NEXT_HINTS[connector]?.[address.slice(dot + 1)];
  if (!hint || !isObject(data) || !Array.isArray(data.items)) return data;
  const row = data.items[0];
  const id = isObject(row) ? row[hint.field ?? "id"] : undefined;
  // Fields selection or a withheld value leaves nothing safe to point at.
  if ((typeof id !== "string" && typeof id !== "number") || /redacted/i.test(String(id))) return data;
  return {
    ...data,
    nextStep: {
      tool: `${connector}.${hint.tool}`,
      idField: hint.field ?? "id",
      passAs: hint.arg,
      ...(hint.template ? { args: hint.template } : { args: { [hint.arg]: id } }),
      purpose: "Read one listed record: use each row's idField, without another search.",
    },
  };
}

/* ---------------------------------------------------------------- the arm */

interface Bound {
  app: Connecta;
  url: string;
  headers: Headers;
  env: unknown;
  ctx: unknown;
}

function typeText(schema: unknown): string {
  if (!isObject(schema)) return "any";
  if (Array.isArray(schema.enum)) return schema.enum.map((item) => JSON.stringify(item)).join("|");
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(typeText).join("|");
  const type = Array.isArray(schema.type) ? schema.type.join("|") : String(schema.type ?? "any");
  if (type === "array") return `${typeText(schema.items)}[]`;
  if (isObject(schema.properties)) {
    const keys = Object.keys(schema.properties);
    return `object{${keys.slice(0, 6).join(",")}${keys.length > 6 ? ",…" : ""}}`;
  }
  return type;
}

const placeholder = (name: string, schema: unknown) => `<${name}: ${typeText(schema)}>`;

/** What a search row can carry from a details contract; never a submitted value. */
function readyFields(row: Json, connector: string, details: Json): Json | undefined {
  if (row.refusal || details.refusal || typeof row.tool !== "string") return undefined;
  const parameters: Json[] = Array.isArray(details.parameters) ? details.parameters : [];
  const accepts: Json = {};
  for (const where of ["path", "query", "header"]) {
    const entries = parameters.filter((param) => param.in === where);
    if (entries.length)
      accepts[where] = Object.fromEntries(
        entries.slice(0, 10).map((param) => [`${param.name}${param.required ? "" : "?"}`, typeText(param.schema)]),
      );
    if (entries.length > 10) accepts[`${where}More`] = entries.length - 10;
  }
  const schema = isObject(details.body?.schema) ? details.body.schema : undefined;
  const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
  if (schema) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const names = Object.keys(properties);
    accepts.body = {
      ...(details.body?.required ? { required: true } : {}),
      ...(names.length
        ? {
            fields: Object.fromEntries(
              names
                .slice(0, 16)
                .map((name) => [`${name}${required.includes(name) ? "" : "?"}`, typeText(properties[name])]),
            ),
          }
        : { type: typeText(schema) }),
      ...(names.length > 16 ? { more: names.length - 16 } : {}),
    };
  }
  const query = parameters.filter((param) => param.in === "query" && param.required);
  const fill = [...String(row.path).matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
  const body =
    schema && (details.body?.required || required.length)
      ? Object.fromEntries(required.map((name) => [name, placeholder(name, schema.properties?.[name])]))
      : undefined;
  return {
    accepts,
    call: {
      address: `${connector}.${row.tool}`,
      args: {
        ...(row.method === "GET" ? {} : { method: row.method }),
        path: row.path,
        ...(query.length
          ? { query: Object.fromEntries(query.map((param) => [param.name, placeholder(param.name, param.schema)])) }
          : {}),
        ...(body ? { body } : {}),
      },
      ...(fill.length || query.length || (body && Object.keys(body).length)
        ? { fill: [...fill, ...query.map((param) => String(param.name)), ...(body ? Object.keys(body) : [])] }
        : {}),
    },
    ...(details.truncated || details.page?.hasMore
      ? { fullContract: `${row.tool.replace(/_(read|write)$/, "_details")}` }
      : {}),
  };
}

/** Prefer a paragraph naming the tool, then its declared arguments. Nothing relevant returns nothing. */
function relevantRule(guide: string, tool: string, keys: readonly string[]): string | undefined {
  const paragraphs = guide
    .replace(/^---[\s\S]*?---/, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph && !paragraph.startsWith("#"));
  const words = keys.filter((key) => key.length >= 3);
  let best: { text: string; score: number } | undefined;
  for (const text of paragraphs) {
    const score = (text.includes(tool) ? 4 : 0) + words.filter((word) => text.includes(word)).length;
    if (score > 0 && (!best || score > best.score)) best = { text, score };
  }
  if (!best) return undefined;
  return best.text.length <= RULE_CHARS ? best.text : `${best.text.slice(0, RULE_CHARS - 1)}…`;
}

/** Guide pointers leave a page only where nothing on it requires the guide. */
function quietGuides(page: unknown): unknown {
  if (!isObject(page)) return page;
  const rows = [
    ...(Array.isArray(page.tools) ? page.tools : []),
    ...(Array.isArray(page.readyCalls) ? page.readyCalls : []),
  ];
  const required = new Set(
    rows.flatMap((row) =>
      isObject(row) && row.guideRequired === true && typeof row.address === "string"
        ? [row.address.slice(0, row.address.indexOf("."))]
        : [],
    ),
  );
  const quiet = (row: unknown) => {
    if (!isObject(row) || row.guideRequired === true) return row;
    const { guide: _guide, guideSummary: _summary, ...rest } = row;
    return rest;
  };
  return {
    ...page,
    ...(Array.isArray(page.tools) ? { tools: page.tools.map(quiet) } : {}),
    ...(isObject(page.connectors)
      ? {
          connectors: Object.fromEntries(
            Object.entries(page.connectors).map(([id, entry]) => [id, required.has(id) ? entry : quiet(entry)]),
          ),
        }
      : {}),
  };
}

const hatchPrefix = (tool: string) => /^(.*)_api_(?:read|write|search|details)$/.exec(tool)?.[1];

export class StepRuntime {
  #bound: Bound | undefined;
  #lookups = new Map<string, Promise<Json | undefined>>();
  constructor(readonly arm: StepArm) {}

  #active() {
    return this.arm !== "control";
  }

  bind(bound: Bound): void {
    this.#bound = bound;
  }

  /** One real read through the caller's own endpoint and token. Cached: discovery reads no account data. */
  #tool(name: string, args: Json): Promise<Json | undefined> {
    const key = JSON.stringify([name, args]);
    let pending = this.#lookups.get(key);
    if (!pending) {
      pending = this.#read(name, args);
      this.#lookups.set(key, pending);
    }
    return pending;
  }

  async #read(name: string, args: Json): Promise<Json | undefined> {
    const bound = this.#bound;
    if (!bound) return undefined;
    const headers = new Headers(bound.headers);
    headers.delete("content-length");
    headers.set("accept", "application/json, text/event-stream");
    headers.set("content-type", "application/json");
    headers.set("MCP-Protocol-Version", "2026-07-28");
    headers.set("Mcp-Method", "tools/call");
    headers.set("Mcp-Name", name);
    if (typeof args.address === "string") headers.set("Mcp-Param-Address", args.address);
    const response = await (bound.app.fetch as (...parts: unknown[]) => Promise<Response>)(
      new Request(bound.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "connecta-eval-step-arm", version: "1.0.0" },
            },
          },
        }),
      }),
      bound.env,
      bound.ctx,
    );
    if (!response.ok) return undefined;
    const wire = await response.text();
    const payload = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? wire
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as Json)
          .find((message) => message.result || message.error)
      : (JSON.parse(wire) as Json);
    const result = payload?.result;
    if (!result || result.isError) return undefined;
    const text = result.content?.find((block: Json) => block.type === "text")?.text;
    if (name === "skills") return typeof text === "string" ? { text } : undefined;
    if (isObject(result.structuredContent) && !("ok" in result.structuredContent)) return result.structuredContent;
    try {
      return JSON.parse(text) as Json;
    } catch {
      return undefined;
    }
  }

  #read_tool(address: string, args: Json) {
    return this.#tool("call_tool", { address, args });
  }

  async #teach(address: string, args: Json, error: Json): Promise<Json | undefined> {
    const dot = address.indexOf(".");
    if (dot < 1) return undefined;
    const connector = address.slice(0, dot);
    const tool = address.slice(dot + 1);
    const prefix = hatchPrefix(tool);
    const issueKeys = (error.validation?.issues ?? []).flatMap((issue: Json) =>
      String(issue.path ?? "")
        .split("/")
        .filter((part) => part && !part.includes("<")),
    );
    const guide = await this.#tool("skills", { name: `connector:${connector}` });
    let teach: Json | undefined;
    if (prefix && typeof args.path === "string") {
      const method = typeof args.method === "string" ? args.method : "GET";
      const details = await this.#read_tool(`${connector}.${prefix}_api_details`, { method, path: args.path });
      if (details && !details.refusal)
        teach = {
          operation: `${details.method} ${details.path}`,
          ...readyFields({ method: details.method, path: details.path, tool }, connector, details),
        };
      if (!teach) {
        const found = await this.#read_tool(`${connector}.${prefix}_api_search`, { query: args.path, limit: 3 });
        const rows = Array.isArray(found?.operations) ? found.operations : [];
        const shown = rows.filter((row: Json) => !row.refusal).slice(0, 3);
        if (shown.length)
          teach = {
            candidates: shown.map((row: Json) => ({
              method: row.method,
              path: row.path,
              tool: `${connector}.${row.tool}`,
            })),
          };
      }
    } else {
      const query = error.code === "unknown_tool" ? tool.replace(/[_-]+/g, " ") : tool;
      const page = await this.#tool("search_tools", { query, connector, includeSchemas: "compact", limit: 3 });
      const rows: Json[] = Array.isArray(page?.tools) ? page.tools : [];
      const exact = rows.find((row) => row.address === address);
      const shown = error.code === "unknown_tool" ? rows : exact ? [exact] : [];
      if (shown.length)
        teach = {
          candidates: shown.map((row) => ({
            address: row.address,
            classification: row.classification,
            inputSchema: row.inputSchema,
            ...(row.requiredInputKeys?.length ? { requiredInputKeys: row.requiredInputKeys } : {}),
            // Teaching never relaxes a prerequisite: the row's requirement travels with its schema.
            ...(row.guideRequired ? { guideRequired: true, guide: `connector:${connector}` } : {}),
          })),
        };
    }
    if (!teach) return undefined;
    const rule = typeof guide?.text === "string" ? relevantRule(guide.text, tool, issueKeys) : undefined;
    if (rule) teach.rule = rule;
    if (bytes(teach) > TEACH_BYTES) {
      delete teach.rule;
      delete teach.accepts;
    }
    return bytes(teach) > TEACH_BYTES ? undefined : teach;
  }

  async #readyRows(address: string, data: unknown): Promise<unknown> {
    if (!isObject(data) || !Array.isArray(data.operations)) return data;
    const dot = address.indexOf(".");
    const connector = address.slice(0, dot);
    const prefix = hatchPrefix(address.slice(dot + 1));
    const rows: Json[] = await Promise.all(
      data.operations.map(async (row: Json) => {
        if (row.refusal) return row;
        const details = await this.#read_tool(`${connector}.${prefix}_api_details`, {
          method: row.method,
          path: row.path,
        });
        const fields = details ? readyFields(row, connector, details) : undefined;
        return fields ? { ...row, ...fields } : row;
      }),
    );
    const result = { ...data, operations: rows };
    // The whole answer stays in 0014's search budget; the plain row remains.
    for (let index = rows.length - 1; index >= 0 && bytes(result) > SEARCH_BYTES; index -= 1) {
      const { accepts: _accepts, call: _call, fullContract: _full, ...plain } = rows[index]!;
      rows[index] = plain;
    }
    return result;
  }

  /** One downstream result, on either route. */
  async #result(address: string, data: unknown): Promise<unknown> {
    if (this.arm === "ready-rows" && address.endsWith("_api_search")) return this.#readyRows(address, data);
    if (this.arm === "next-hints") return hinted(address, data);
    return data;
  }

  /** Rewrite one top-level tools/call, before dispatch. */
  request(name: unknown, args: Json | undefined): Json | undefined {
    if (this.arm !== "merged-tools" || !args) return args;
    if (name === "call_tool" || name === "call_destructive_tool") {
      const dispatch = mergedDispatch(args.address, args.args);
      return dispatch ? { ...args, ...dispatch } : args;
    }
    if (name === "search_tools" && typeof args.query === "string")
      return {
        ...args,
        query: args.query
          .replace(new RegExp(`\\b${ENV_TOOL}\\b`, "g"), "environment variable")
          .replace(new RegExp(`\\b${LOG_TOOL}\\b`, "g"), "logs"),
      };
    return args;
  }

  /** The whole top-level reply text for one tools/call. */
  async reply(name: unknown, requested: Json | undefined, result: Json): Promise<Json> {
    if (!this.#active()) return result;
    if (this.arm === "merged-tools") {
      const merged = renamed(result);
      if (name !== "search_tools" && name !== "skills") return merged;
      return this.#mapText(merged, (value) =>
        isObject(value) && Array.isArray(value.tools) ? { ...value, tools: mergedRows(value.tools) } : value,
      );
    }
    if (name === "search_tools" && this.arm === "teach-errors") return this.#mapText(result, quietGuides);
    if (name !== "call_tool" && name !== "call_destructive_tool") return result;
    const address = typeof requested?.address === "string" ? requested.address : "";
    const args = isObject(requested?.args) ? requested.args : {};
    if (result.isError) {
      if (this.arm !== "teach-errors") return result;
      return this.#mapTextAsync(result, async (value) => {
        if (!isObject(value) || !isObject(value.error)) return value;
        return { ...value, error: await this.#taught(address, args, value.error) };
      });
    }
    return this.#mapTextAsync(result, (value) => this.#result(address, value));
  }

  async #taught(address: string, args: Json, error: Json): Promise<Json> {
    if (!["invalid_args", "unknown_tool"].includes(error.code) || error.writeOutcome === "unknown") return error;
    const teach = await this.#teach(address, args, error).catch(() => undefined);
    return teach ? { ...error, teach } : error;
  }

  #mapText(result: Json, map: (value: unknown) => unknown): Json {
    return this.#blocks(result, map) as Json;
  }

  async #mapTextAsync(result: Json, map: (value: unknown) => unknown | Promise<unknown>): Promise<Json> {
    const content = await Promise.all(
      (result.content ?? []).map(async (block: Json) => {
        if (block.type !== "text" || typeof block.text !== "string") return block;
        let parsed: unknown;
        try {
          parsed = JSON.parse(block.text);
        } catch {
          return block;
        }
        return { ...block, text: JSON.stringify(await map(parsed)) };
      }),
    );
    return {
      ...result,
      content,
      ...(result.structuredContent === undefined ? {} : { structuredContent: await map(result.structuredContent) }),
    };
  }

  #blocks(result: Json, map: (value: unknown) => unknown): Json {
    return {
      ...result,
      content: (result.content ?? []).map((block: Json) => {
        if (block.type !== "text" || typeof block.text !== "string") return block;
        try {
          return { ...block, text: JSON.stringify(map(JSON.parse(block.text))) };
        } catch {
          return block;
        }
      }),
      ...(result.structuredContent === undefined ? {} : { structuredContent: map(result.structuredContent) }),
    };
  }

  /** Guest bridge: what `connecta.call` and friends actually receive. Observation records the agent's arguments. */
  guestArgs(name: string, args: unknown[]): unknown[] {
    if (this.arm !== "merged-tools") return args;
    if (name === "connecta.call") {
      const dispatch = mergedDispatch(args[0], args[1]);
      return dispatch ? [dispatch.address, dispatch.args, ...args.slice(2)] : args;
    }
    if (name === "connecta.search" && isObject(args[0]))
      return [this.request("search_tools", args[0]), ...args.slice(1)];
    return args;
  }

  async guestResult(name: string, args: unknown[], value: unknown): Promise<unknown> {
    if (!this.#active()) return value;
    if (this.arm === "merged-tools") {
      const merged = renamed(value);
      return (name === "connecta.search" || name === "connecta.describe") &&
        isObject(merged) &&
        Array.isArray(merged.tools)
        ? { ...merged, tools: mergedRows(merged.tools) }
        : merged;
    }
    if (this.arm === "teach-errors" && (name === "connecta.search" || name === "connecta.describe"))
      return quietGuides(value);
    if (name === "connecta.call" && isObject(value) && typeof args[0] === "string")
      return value.data === undefined ? value : { ...value, data: await this.#result(args[0], value.data) };
    return value;
  }

  /** Keep the thrown error's prototype and fields: the bridges transport `details`. */
  async guestError(name: string, args: unknown[], error: unknown): Promise<unknown> {
    if (!this.#active() || !isObject(error)) return error;
    const fields = error as Json;
    if (this.arm === "merged-tools") {
      if (isObject(fields.details)) fields.details = renamed(fields.details);
      if (typeof fields.message === "string") fields.message = renamed(fields.message);
      return error;
    }
    if (this.arm !== "teach-errors" || name !== "connecta.call" || typeof args[0] !== "string") return error;
    const details = isObject(fields.details) ? fields.details : { code: fields.code, message: fields.message };
    const taught = await this.#taught(args[0], isObject(args[1]) ? args[1] : {}, details);
    if (taught !== details) fields.details = taught;
    return error;
  }
}

export function stepRuntime(arm: StepArm | undefined): StepRuntime | undefined {
  return arm === undefined || arm === "control" ? undefined : new StepRuntime(arm);
}

/** Preserve transport, authentication and every downstream boundary; change only the arm's replies. */
export function forStepArm(app: Connecta, runtime: StepRuntime | undefined): Connecta {
  if (!runtime) return app;
  return {
    ...app,
    async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || !(path.startsWith("/mcp") || path.startsWith("/agent/")))
        return app.fetch(request, env, ctx);
      const body = (await request
        .clone()
        .json()
        .catch(() => undefined)) as Json | undefined;
      if (!isObject(body) || body.method !== "tools/call") return app.fetch(request, env, ctx);
      runtime.bind({ app, url: request.url, headers: new Headers(request.headers), env, ctx });
      const name = body.params?.name;
      const requested: Json | undefined = runtime.request(name, body.params?.arguments);
      let forwarded = request;
      if (requested !== body.params?.arguments) {
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        // The MCP boundary checks the declared header against the body.
        if (headers.has("Mcp-Param-Address") && typeof requested?.address === "string")
          headers.set("Mcp-Param-Address", requested.address);
        forwarded = new Request(request, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, params: { ...body.params, arguments: requested } }),
        });
      }
      const response = await app.fetch(forwarded, env, ctx);
      if (!response.ok) return response;
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("application/json") && !type.includes("text/event-stream")) return response;
      const original = (body.params?.arguments ?? {}) as Json;
      const transform = async (message: Json): Promise<Json> =>
        isObject(message.result)
          ? { ...message, result: await runtime.reply(name, original, message.result) }
          : message;
      const text = await response.text();
      const changed = type.includes("application/json")
        ? JSON.stringify(await transform(JSON.parse(text) as Json))
        : (
            await Promise.all(
              text.split("\n").map(async (line) => {
                if (!line.startsWith("data: ")) return line;
                try {
                  return `data: ${JSON.stringify(await transform(JSON.parse(line.slice(6)) as Json))}`;
                } catch {
                  return line;
                }
              }),
            )
          ).join("\n");
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(changed, { status: response.status, headers });
    },
  };
}
